//! RTT（SEGGER Real-Time Transfer）命令：与探针会话共享同一条 SWD 连接。
//!
//! 设计要点：
//! - 控制块扫描在启动命令里同步完成，失败直接返回可读错误；
//! - 轮询线程只在拿到会话锁时读数据，烧录期间用 try_lock_for 跳过，不阻塞烧录；
//! - 上行数据按 base64 批量发给前端，下行数据入队后由轮询线程写出；
//! - 目标复位导致控制块变化时丢弃旧句柄并重新扫描。
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use parking_lot::Mutex;
use probe_rs::rtt::{Rtt, ScanRegion};
use probe_rs::{Core, Session};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

use crate::state::{AppState, RttState};

/// 单轮最多搬运的字节数，避免目标高速输出时长期占用会话锁
const READ_BUDGET_PER_TICK: usize = 128 * 1024;
/// 下行队列上限，目标不读时避免内存无限增长
const MAX_DOWN_PENDING: usize = 256 * 1024;
/// 目标复位/swap 期间控制块可能短时间不存在，超过该时长仍找不到才判定失败
const REATTACH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Deserialize)]
pub struct RttStartOptions {
    /// auto = 扫描 RAM；exact = 使用 address 指定的控制块地址
    #[serde(default)]
    pub scan_mode: Option<String>,
    #[serde(default)]
    pub address: Option<u64>,
    #[serde(default)]
    pub poll_interval_ms: Option<u64>,
    #[serde(default)]
    pub auto_reattach: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RttChannelInfo {
    pub index: usize,
    pub name: Option<String>,
    pub buffer_size: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct RttConfig {
    pub control_block_address: u64,
    pub up_channels: Vec<RttChannelInfo>,
    pub down_channels: Vec<RttChannelInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RttDataChunk {
    pub channel: usize,
    /// base64 编码的原始字节
    pub data: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RttDataEvent {
    pub chunks: Vec<RttDataChunk>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RttStatusEvent {
    pub running: bool,
    pub attached: bool,
    pub error: Option<String>,
    pub config: Option<RttConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RttWriteOptions {
    #[serde(default)]
    pub channel: Option<usize>,
    pub text: String,
    #[serde(default)]
    pub hex: bool,
    #[serde(default)]
    pub line_ending: Option<String>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn config_of(rtt: &Rtt) -> RttConfig {
    RttConfig {
        control_block_address: rtt.ptr(),
        up_channels: rtt
            .up_channels
            .iter()
            .map(|channel| RttChannelInfo {
                index: channel.number(),
                name: channel.name().map(str::to_string),
                buffer_size: channel.buffer_size(),
            })
            .collect(),
        down_channels: rtt
            .down_channels
            .iter()
            .map(|channel| RttChannelInfo {
                index: channel.number(),
                name: channel.name().map(str::to_string),
                buffer_size: channel.buffer_size(),
            })
            .collect(),
    }
}

fn attach_with_core(
    core: &mut Core<'_>,
    scan_mode: &str,
    address: Option<u64>,
) -> Result<(Rtt, RttConfig), String> {
    let region = match scan_mode {
        "exact" => {
            let address = address.ok_or_else(|| "精确模式需要填写 RTT 控制块地址".to_string())?;
            ScanRegion::Exact(address)
        }
        _ => ScanRegion::Ram,
    };

    let rtt = Rtt::attach_region(core, &region).map_err(|error| {
        format!(
            "未找到 RTT 控制块（{error:?}）。请确认固件已初始化 SEGGER RTT，且程序已经运行到初始化之后；\
             也可以改用精确地址模式直接指定控制块地址。"
        )
    })?;
    let config = config_of(&rtt);
    Ok((rtt, config))
}

fn attach_rtt(
    session: &mut Session,
    scan_mode: &str,
    address: Option<u64>,
) -> Result<(Rtt, RttConfig), String> {
    let mut core = session.core(0).map_err(|error| format!("访问内核失败: {error}"))?;
    attach_with_core(&mut core, scan_mode, address)
}

/// 读取全部上行通道。返回 Err 表示控制块可能已失效（例如目标复位）。
fn read_all_channels(
    core: &mut Core<'_>,
    rtt: &mut Rtt,
    buffer: &mut [u8],
    timestamp: u64,
) -> Result<Vec<RttDataChunk>, String> {
    let mut chunks = Vec::new();
    let mut budget = READ_BUDGET_PER_TICK;

    for channel in rtt.up_channels.iter_mut() {
        let number = channel.number();
        loop {
            if budget == 0 {
                return Ok(chunks);
            }
            let slice_len = buffer.len().min(budget);
            let slice = &mut buffer[..slice_len];
            match channel.read(core, slice) {
                Ok(0) => break,
                Ok(read) => {
                    budget -= read;
                    chunks.push(RttDataChunk {
                        channel: number,
                        data: BASE64.encode(&slice[..read]),
                        timestamp,
                    });
                    if read < slice.len() {
                        break;
                    }
                }
                Err(error) => return Err(format!("RTT 读取失败: {error:?}")),
            }
        }
    }

    Ok(chunks)
}

/// 把下行队列尽量写入目标；目标暂不接收时留到下一轮。
fn flush_down(core: &mut Core<'_>, rtt: &mut Rtt, rtt_state: &RttState) -> Option<String> {
    loop {
        let front = rtt_state.down.lock().pending.front().cloned();
        let Some((channel, data)) = front else {
            return None;
        };

        let Some(down_channel) = rtt
            .down_channels
            .iter_mut()
            .find(|candidate| candidate.number() == channel)
        else {
            // 目标端关闭了该通道：丢弃对应数据
            rtt_state.down.lock().pending.pop_front();
            continue;
        };

        match down_channel.write(core, &data) {
            Ok(0) => return None,
            Ok(written) => {
                let mut queue = rtt_state.down.lock();
                if let Some(item) = queue.pending.front_mut() {
                    if written >= data.len() {
                        queue.pending.pop_front();
                    } else {
                        item.1.drain(..written);
                    }
                }
            }
            Err(error) => return Some(format!("RTT 下行写入失败: {error:?}")),
        }
    }
}

fn spawn_poller(
    app: AppHandle,
    session_slot: Arc<Mutex<Option<Session>>>,
    rtt_state: Arc<RttState>,
    rtt: Rtt,
    generation: u64,
    options: RttStartOptions,
) {
    let interval = Duration::from_millis(options.poll_interval_ms.unwrap_or(10).clamp(2, 500));
    let scan_mode = options.scan_mode.unwrap_or_else(|| "auto".into());
    let address = options.address;
    let auto_reattach = options.auto_reattach.unwrap_or(true);
    let app_for_thread = app.clone();
    let state_for_thread = Arc::clone(&rtt_state);

    let spawned = thread::Builder::new()
        .name("rtt-poller".into())
        .spawn(move || {
            let app = app_for_thread;
            let rtt_state = state_for_thread;
            let mut rtt = Some(rtt);
            let mut buffer = vec![0u8; 16 * 1024];
            let mut failing_since: Option<Instant> = None;
            let mut reattach_notified = false;
            let mut terminal_error: Option<String> = None;

            while rtt_state.run.is_current(generation) {
                thread::sleep(interval);

                // 烧录/连接等长操作会长时间持有会话锁：拿不到就跳过本轮
                let Some(mut guard) = session_slot.try_lock_for(Duration::from_millis(400)) else {
                    continue;
                };
                let Some(session) = guard.as_mut() else {
                    terminal_error = Some("探针已断开，RTT 已停止".into());
                    break;
                };
                let mut core = match session.core(0) {
                    Ok(core) => core,
                    Err(error) => {
                        terminal_error = Some(format!("访问内核失败: {error}"));
                        break;
                    }
                };

                // 控制块失效后自动重新扫描
                if rtt.is_none() {
                    match attach_with_core(&mut core, &scan_mode, address) {
                        Ok((new_rtt, config)) => {
                            rtt_state
                                .down
                                .lock()
                                .reset(config.down_channels.iter().map(|c| c.index).collect());
                            rtt = Some(new_rtt);
                            failing_since = None;
                            reattach_notified = false;
                            let _ = app.emit(
                                "rtt-status",
                                RttStatusEvent {
                                    running: true,
                                    attached: true,
                                    error: None,
                                    config: Some(config),
                                },
                            );
                        }
                        Err(error) => {
                            let since = *failing_since.get_or_insert_with(Instant::now);
                            if !auto_reattach || since.elapsed() > REATTACH_TIMEOUT {
                                terminal_error = Some(error);
                                break;
                            }
                            if !reattach_notified {
                                reattach_notified = true;
                                let _ = app.emit(
                                    "rtt-status",
                                    RttStatusEvent {
                                        running: true,
                                        attached: false,
                                        error: Some(
                                            "RTT 控制块暂时不可用（目标可能正在复位），正在重试…".into(),
                                        ),
                                        config: None,
                                    },
                                );
                            }
                            continue;
                        }
                    }
                }

                let timestamp = now_millis();
                let read_result = match rtt.as_mut() {
                    Some(rtt) => read_all_channels(&mut core, rtt, &mut buffer, timestamp),
                    None => Ok(Vec::new()),
                };

                match read_result {
                    Ok(chunks) => {
                        failing_since = None;
                        reattach_notified = false;
                        let write_error = match rtt.as_mut() {
                            Some(rtt) => flush_down(&mut core, rtt, &rtt_state),
                            None => None,
                        };
                        drop(core);
                        drop(guard);

                        if !chunks.is_empty() {
                            let _ = app.emit("rtt-data", RttDataEvent { chunks });
                        }
                        if let Some(error) = write_error {
                            let _ = app.emit(
                                "rtt-status",
                                RttStatusEvent {
                                    running: true,
                                    attached: true,
                                    error: Some(error),
                                    config: None,
                                },
                            );
                        }
                    }
                    Err(error) => {
                        // 目标复位后控制块通常失效：丢弃句柄，下一轮重新扫描
                        rtt = None;
                        drop(core);
                        drop(guard);

                        let since = *failing_since.get_or_insert_with(Instant::now);
                        if !auto_reattach || since.elapsed() > REATTACH_TIMEOUT {
                            terminal_error = Some(format!("{error}（控制块重新扫描失败）"));
                            break;
                        }
                        if !reattach_notified {
                            reattach_notified = true;
                            let _ = app.emit(
                                "rtt-status",
                                RttStatusEvent {
                                    running: true,
                                    attached: false,
                                    error: Some("RTT 连接中断，正在重新扫描控制块…".into()),
                                    config: None,
                                },
                            );
                        }
                    }
                }
            }

            if rtt_state.run.finish(generation) {
                rtt_state.down.lock().reset(Vec::new());
                let _ = app.emit(
                    "rtt-status",
                    RttStatusEvent {
                        running: false,
                        attached: false,
                        error: terminal_error,
                        config: None,
                    },
                );
            }
        });

    if let Err(error) = spawned {
        rtt_state.run.finish(generation);
        let _ = app.emit(
            "rtt-status",
            RttStatusEvent {
                running: false,
                attached: false,
                error: Some(format!("RTT 轮询线程启动失败: {error}")),
                config: None,
            },
        );
    }
}

/// 启动 RTT：扫描并附着控制块，然后返回上行/下行通道信息。
#[tauri::command]
pub async fn start_rtt(
    app: AppHandle,
    state: State<'_, AppState>,
    options: RttStartOptions,
) -> Result<RttConfig, String> {
    let connected = { state.session.lock().is_some() };
    if !connected {
        return Err("请先连接调试探针".into());
    }

    let Some(generation) = state.rtt_state.run.try_start() else {
        return Err("RTT 已在运行".into());
    };

    let session_slot = Arc::clone(&state.session);
    let scan_mode = options.scan_mode.clone().unwrap_or_else(|| "auto".into());
    let address = options.address;

    let attached = tauri::async_runtime::spawn_blocking(move || -> Result<(Rtt, RttConfig), String> {
        let mut guard = session_slot.lock();
        let Some(session) = guard.as_mut() else {
            return Err("探针未连接".into());
        };
        attach_rtt(session, &scan_mode, address)
    })
    .await
    .map_err(|error| format!("RTT 附着任务异常: {error}"))?;

    let (rtt, config) = match attached {
        Ok(attached) => attached,
        Err(error) => {
            state.rtt_state.run.finish(generation);
            return Err(error);
        }
    };

    state
        .rtt_state
        .down
        .lock()
        .reset(config.down_channels.iter().map(|c| c.index).collect());

    spawn_poller(
        app,
        Arc::clone(&state.session),
        Arc::clone(&state.rtt_state),
        rtt,
        generation,
        options,
    );

    Ok(config)
}

#[tauri::command]
pub fn stop_rtt(state: State<'_, AppState>) -> Result<(), String> {
    state.rtt_state.run.stop();
    state.rtt_state.down.lock().reset(Vec::new());
    Ok(())
}

fn parse_hex(input: &str) -> Result<Vec<u8>, String> {
    let cleaned = input.replace("0x", "").replace("0X", "");
    let compact: String = cleaned
        .chars()
        .filter(|ch| !ch.is_whitespace() && *ch != ',' && *ch != ';')
        .collect();
    if compact.is_empty() {
        return Ok(Vec::new());
    }
    if compact.len() % 2 != 0 || !compact.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("HEX 格式错误：需要偶数个十六进制字符，例如 AA 55 01".into());
    }
    Ok((0..compact.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&compact[index..index + 2], 16).unwrap_or(0))
        .collect())
}

/// 下行写入：数据先入队，由轮询线程在持有会话锁时写入目标。
#[tauri::command]
pub fn write_rtt(state: State<'_, AppState>, options: RttWriteOptions) -> Result<usize, String> {
    if !state.rtt_state.is_running() {
        return Err("RTT 未启动".into());
    }

    let data = if options.hex {
        parse_hex(&options.text)?
    } else {
        let mut bytes = options.text.into_bytes();
        match options.line_ending.as_deref().unwrap_or("none") {
            "lf" => bytes.push(b'\n'),
            "crlf" => bytes.extend_from_slice(b"\r\n"),
            "cr" => bytes.push(b'\r'),
            _ => {}
        }
        bytes
    };
    if data.is_empty() {
        return Ok(0);
    }

    let mut queue = state.rtt_state.down.lock();
    if queue.channels.is_empty() {
        return Err("固件没有提供 RTT 下行通道".into());
    }
    let channel = options.channel.unwrap_or(queue.channels[0]);
    if !queue.channels.contains(&channel) {
        return Err(format!("RTT 下行通道 {channel} 不存在"));
    }
    if queue.pending_bytes() + data.len() > MAX_DOWN_PENDING {
        return Err("RTT 下行队列已满（目标未及时读取）".into());
    }
    queue.pending.push_back((channel, data));
    Ok(channel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_hex_accepts_common_separators() {
        assert_eq!(
            parse_hex("AA 55,0x01;ff").unwrap(),
            vec![0xAA, 0x55, 0x01, 0xFF]
        );
        assert!(parse_hex("A").is_err());
        assert!(parse_hex("GG").is_err());
        assert!(parse_hex("  ").unwrap().is_empty());
    }
}
