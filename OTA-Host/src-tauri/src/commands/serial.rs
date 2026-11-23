use crate::serial::{list_serial_ports, LocalSerial, SerialConfig, SerialPortInfo};
use crate::state::{AppState, DataSource, SerialState};
use serde::Serialize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// Serial data event payload
#[derive(Clone, Serialize)]
struct SerialDataChunk {
    data: Vec<u8>,
    timestamp: i64,
}

#[derive(Clone, Serialize)]
struct SerialDataEvent {
    chunks: Vec<SerialDataChunk>,
    direction: String, // "rx" for received data
}

/// Serial status event payload
#[derive(Clone, Serialize)]
struct SerialStatusEvent {
    connected: bool,
    running: bool,
    error: Option<String>,
}

/// List available serial ports
#[tauri::command]
pub fn list_serial_ports_cmd() -> Result<Vec<SerialPortInfo>, String> {
    list_serial_ports()
}

/// Connect to a serial port
#[tauri::command]
pub async fn connect_serial(config: SerialConfig, state: State<'_, AppState>) -> Result<(), String> {
    let serial_state = Arc::clone(&state.serial_state);
    run_blocking(move || {
        // Stop any existing polling first
        serial_state.run.stop();
        take_and_disconnect(&serial_state);

        let mut datasource: Box<dyn DataSource> = match config {
            SerialConfig::Local {
                port,
                baud_rate,
                data_bits,
                stop_bits,
                parity,
                flow_control,
                dtr,
                rts,
            } => Box::new(LocalSerial::new(
                port,
                baud_rate,
                data_bits,
                stop_bits,
                &parity,
                &flow_control,
                dtr,
                rts,
            )),
        };

        // 在锁外建立连接，期间不挡住其他命令
        datasource.connect()?;
        *serial_state.datasource.lock() = Some(datasource);
        Ok(())
    })
    .await
}

/// Disconnect from serial port
#[tauri::command]
pub async fn disconnect_serial(state: State<'_, AppState>) -> Result<(), String> {
    let serial_state = Arc::clone(&state.serial_state);
    run_blocking(move || {
        serial_state.run.stop();
        match serial_state.datasource.lock().take() {
            Some(mut ds) => ds.disconnect(),
            None => Ok(()),
        }
    })
    .await
}

/// 取出当前数据源并断开；取出后立即释放锁，断开过程不占用锁
fn take_and_disconnect(serial_state: &SerialState) {
    let previous = serial_state.datasource.lock().take();
    if let Some(mut ds) = previous {
        let _ = ds.disconnect();
    }
}

async fn run_blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

async fn write_serial_bytes(serial_state: &Arc<SerialState>, data: Vec<u8>) -> Result<usize, String> {
    let serial_state = Arc::clone(serial_state);
    run_blocking(move || {
        let mut guard = serial_state.datasource.lock();
        let ds = guard.as_mut().ok_or_else(|| "Serial port not connected".to_string())?;
        ds.write(&data)
    })
    .await
}

/// Write data to serial port
#[tauri::command]
pub async fn write_serial(data: Vec<u8>, state: State<'_, AppState>) -> Result<usize, String> {
    write_serial_bytes(&state.serial_state, data).await
}

/// Write string to serial port with optional line ending（v1 固定 UTF-8）
#[tauri::command]
pub async fn write_serial_string(
    text: String,
    line_ending: Option<String>,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let text = match line_ending.as_deref() {
        Some("lf") => format!("{}\n", text),
        Some("crlf") => format!("{}\r\n", text),
        Some("cr") => format!("{}\r", text),
        _ => text,
    };
    write_serial_bytes(&state.serial_state, text.into_bytes()).await
}

/// Start serial polling
///
/// 架构：专用阻塞读线程 + tokio mpsc + async 批处理。
/// - 读线程独占一个 OS 线程，常驻在 `read()` 上，最大程度压低 OS 驱动 RX FIFO 占用，避免高 baud 时丢字节。
/// - async 侧只做 batching/emit，不再用 polling timer。
#[tauri::command]
pub async fn start_serial(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if state.serial_state.is_running() {
        return Ok(());
    }

    if !state.serial_state.is_connected() {
        return Err("Serial port not connected".to_string());
    }

    let serial_state = Arc::clone(&state.serial_state);
    let generation = serial_state.run.start();

    // mpsc 通道：reader -> async accumulator。无界，让读线程永远不会被反压阻塞。
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<SerialDataChunk>();

    // ===== 读线程：独立 OS 线程，循环 read() 并把每段 chunk 发到 channel =====
    let reader_state = Arc::clone(&serial_state);
    let reader_app = app.clone();
    std::thread::Builder::new()
        .name("serial-reader".into())
        .spawn(move || {
            let mut local_buf = vec![0u8; 16384];

            loop {
                // 代次变化说明已被停止或被新一轮启动取代，旧线程必须退出
                if !reader_state.run.is_current(generation) {
                    break;
                }

                // 进入临界区只为这一次 read，结束就解锁，避免长时间挡 write/disconnect。
                let result = {
                    let mut guard = reader_state.datasource.lock();
                    match guard.as_mut() {
                        Some(ds) => ds.read(&mut local_buf),
                        None => break,
                    }
                };

                match result {
                    Ok(0) => {
                        // 50ms timeout 触发，没有数据，立刻再 read。
                        continue;
                    }
                    Ok(n) => {
                        let chunk = SerialDataChunk {
                            data: local_buf[..n].to_vec(),
                            timestamp: chrono::Utc::now().timestamp_millis(),
                        };
                        if tx.send(chunk).is_err() {
                            // accumulator 已退出，没人收了。
                            break;
                        }
                    }
                    Err(e) => {
                        // 读失败后旧句柄已经不可用，必须先释放并断开；
                        // 否则 is_connected() 仍会把断线状态覆盖成"已连接"。
                        {
                            let mut guard = reader_state.datasource.lock();
                            if let Some(ds) = guard.as_mut() {
                                let _ = ds.disconnect();
                            }
                        }
                        if reader_state.run.finish(generation) {
                            let _ = reader_app.emit(
                                "serial-status",
                                SerialStatusEvent {
                                    connected: false,
                                    running: false,
                                    error: Some(e),
                                },
                            );
                        }
                        break;
                    }
                }
            }
            // tx drop -> accumulator 收到 None 退出
        })
        .map_err(|e| format!("Failed to spawn reader thread: {}", e))?;

    // ===== async accumulator：batch + emit =====
    let accumulator_state = Arc::clone(&serial_state);
    tokio::spawn(async move {
        const BATCH_TIMEOUT_MS: u64 = 10;
        const BATCH_SIZE_THRESHOLD: usize = 4096;

        let mut batch_chunks: Vec<SerialDataChunk> = Vec::new();
        let mut batch_bytes = 0usize;
        let mut last_emit = Instant::now();
        let mut tick = tokio::time::interval(Duration::from_millis(BATCH_TIMEOUT_MS));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                msg = rx.recv() => {
                    match msg {
                        Some(chunk) => {
                            batch_bytes += chunk.data.len();
                            batch_chunks.push(chunk);
                            if batch_bytes >= BATCH_SIZE_THRESHOLD {
                                let chunks = std::mem::take(&mut batch_chunks);
                                batch_bytes = 0;
                                let _ = app.emit(
                                    "serial-data",
                                    SerialDataEvent {
                                        chunks,
                                        direction: "rx".to_string(),
                                    },
                                );
                                last_emit = Instant::now();
                            }
                        }
                        None => break, // reader thread 退出 -> channel 关闭
                    }
                }
                _ = tick.tick() => {
                    if !batch_chunks.is_empty()
                        && last_emit.elapsed().as_millis() as u64 >= BATCH_TIMEOUT_MS
                    {
                        let chunks = std::mem::take(&mut batch_chunks);
                        batch_bytes = 0;
                        let _ = app.emit(
                            "serial-data",
                            SerialDataEvent {
                                chunks,
                                direction: "rx".to_string(),
                            },
                        );
                        last_emit = Instant::now();
                    }
                }
            }
        }

        // flush 残留
        if !batch_chunks.is_empty() {
            let _ = app.emit(
                "serial-data",
                SerialDataEvent {
                    chunks: batch_chunks,
                    direction: "rx".to_string(),
                },
            );
        }

        // 正常停止时同步 running=false；读失败已经由 reader 上报，不能再用
        // 无错误的结束事件覆盖断线原因；已被新一轮启动取代时也不能发。
        if !accumulator_state.is_running() && accumulator_state.is_connected() {
            let _ = app.emit(
                "serial-status",
                SerialStatusEvent {
                    connected: true,
                    running: false,
                    error: None,
                },
            );
        }
    });

    Ok(())
}

/// Stop serial polling
#[tauri::command]
pub fn stop_serial(state: State<'_, AppState>) -> Result<(), String> {
    state.serial_state.run.stop();
    Ok(())
}
