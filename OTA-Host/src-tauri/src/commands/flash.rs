//! probe-rs 原生烧录（参考 OmniProbe 架构）：
//! 复用已连接的探针会话，imgtool --pad 产物按"有效数据段"烧写——
//! 跳过与擦除态一致的 0xFF 填充（384KB 槽只写 ~20KB 实数据），
//! 段级预校验跳过已一致内容（重复烧录同版本近乎零耗时），
//! 结构化进度通过 "flash-progress" 事件推给前端。
use crate::state::AppState;
use parking_lot::Mutex;
use probe_rs::flashing::{DownloadOptions, FlashProgress, ProgressEvent, ProgressOperation};
use probe_rs::{MemoryInterface, Session};
use serde::{Deserialize, Serialize};
use std::ops::Range;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// 0xFF 填充间隙达到该值才分段（保证 trailer 安全区不与镜像段重叠）
const MIN_GAP: usize = 16 * 1024;
/// trailer 安全区：magic 之前必写的字节数。
/// 覆盖 swap status / copy_done / image_ok 等 trailer 字段——
/// 防止旧槽残留的 trailer 标志位（如 copy_done=0x01）逃过刷新干扰 swap 状态机。
const TRAILER_MARGIN: usize = 8 * 1024;

/// 进度跟踪状态（擦除 0-30%、编程 30-90%、收尾 90-100%）
#[derive(Debug)]
struct ProgressState {
    erase_total: u64,
    erase_current: u64,
    program_total: u64,
    program_current: u64,
}

impl ProgressState {
    fn new() -> Self {
        Self {
            erase_total: 0,
            erase_current: 0,
            program_total: 0,
            program_current: 0,
        }
    }

    fn calculate_progress(&self) -> f32 {
        if self.program_total > 0 {
            // 编程阶段: 30% - 90%
            0.30 + (self.program_current as f32 / self.program_total as f32) * 0.60
        } else if self.erase_total > 0 {
            // 擦除阶段: 0% - 30%
            (self.erase_current as f32 / self.erase_total as f32) * 0.30
        } else {
            0.0
        }
    }
}

/// 烧录参数。地址由前端按槽位计算（Primary 0x08020000 / Secondary 0x08080000）。
#[derive(Debug, Clone, Deserialize)]
pub struct FlashOptions {
    pub bin_path: String,
    /// 烧录目标地址（BIN 基地址）
    pub address: u64,
    /// 烧录后校验
    #[serde(default = "default_true")]
    pub verify: bool,
    /// 烧录后复位芯片
    #[serde(default = "default_true")]
    pub reset_after: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
pub struct FlashProgressEvent {
    pub phase: String,
    pub progress: f32,
    pub message: String,
}

fn emit_progress(app: &AppHandle, phase: &str, progress: f32, message: String) {
    let _ = app.emit(
        "flash-progress",
        FlashProgressEvent {
            phase: phase.to_string(),
            progress,
            message,
        },
    );
}

#[tauri::command]
pub async fn flash_firmware(
    options: FlashOptions,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    // 烧录可能持续数十秒，整段放到阻塞线程执行
    let session_slot = Arc::clone(&state.session);
    tauri::async_runtime::spawn_blocking(move || {
        // 烧录期间持有 session 锁；未连接直接报错
        let mut guard = session_slot.lock();
        let session = guard.as_mut().ok_or("尚未连接探针，请先连接")?;
        flash_firmware_blocking(session, options, app)
    })
    .await
    .map_err(|e| format!("烧录任务异常: {e}"))?
}

/// imgtool --pad 产物布局：[镜像主体][0xFF 填充][trailer(尾部 magic)]。
/// 返回需要写入的数据段；中间 0xFF 填充与擦除态一致，跳过不写。
/// MCUboot 只校验 [header, 镜像+TLV] 区间和槽尾 trailer，中间内容不参与。
fn find_spans(data: &[u8]) -> Vec<Range<usize>> {
    let len = data.len();
    // 末尾纯 0xFF（通常没有，magic 止于文件末尾）
    let mut end = len;
    while end > 0 && data[end - 1] == 0xFF {
        end -= 1;
    }
    if end == 0 {
        return vec![];
    }
    // trailer：最后一段连续非 0xFF（magic 本体）
    let mut magic_start = end;
    while magic_start > 0 && data[magic_start - 1] != 0xFF {
        magic_start -= 1;
    }
    // magic 前保留安全区，确保 trailer 全字段刷新
    let span2_start = magic_start.saturating_sub(TRAILER_MARGIN);
    // 从安全区起点向前扫 0xFF 填充，定位镜像主体终点
    let mut image_end = span2_start;
    while image_end > 0 && data[image_end - 1] == 0xFF {
        image_end -= 1;
    }
    if image_end > 0 && span2_start > image_end && span2_start - image_end >= MIN_GAP {
        vec![0..image_end, span2_start..len]
    } else {
        vec![0..len]
    }
}

fn flash_firmware_blocking(
    session: &mut Session,
    options: FlashOptions,
    app: AppHandle,
) -> Result<(), String> {
    let path = Path::new(&options.bin_path);
    if !path.exists() {
        return Err(format!("文件不存在: {}", options.bin_path));
    }
    match path.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref() {
        Some("bin") => {}
        other => return Err(format!("仅支持 BIN 格式（签名产物），当前扩展名: {other:?}")),
    }

    let data = std::fs::read(path).map_err(|e| format!("读取固件失败: {e}"))?;
    if data.is_empty() {
        return Err("固件文件为空".into());
    }
    let base = options.address;

    let spans = find_spans(&data);
    if spans.is_empty() {
        return Err("固件内容全为 0xFF，无需烧录".into());
    }

    let total: u64 = spans.iter().map(|s| s.len() as u64).sum();
    let skipped_gap = data.len() as u64 - total;
    if skipped_gap > 0 {
        emit_progress(
            &app,
            "info",
            0.0,
            format!(
                "固件 {} 字节，0xFF 填充 {} 字节跳过不写，实写 {} 字节",
                data.len(),
                skipped_gap,
                total
            ),
        );
    }

    // 预校验：逐段读回比较，已一致的段跳过（probe-rs 0.32 的 preverify 未实现，自行实现段级比较）
    let mut loader = session.target().flash_loader();
    let mut all_identical = true;
    let mut verified_bytes = 0u64;
    for span in &spans {
        let addr = base + span.start as u64;
        let file_bytes = &data[span.start..span.end];
        let mut current = vec![0u8; file_bytes.len()];
        {
            let mut core = session
                .core(0)
                .map_err(|e| format!("访问内核失败: {e}"))?;
            core.read(addr, &mut current)
                .map_err(|e| format!("预校验读取失败 @0x{:08X}: {e}", addr))?;
        }
        verified_bytes += file_bytes.len() as u64;
        emit_progress(
            &app,
            "preverify",
            0.0,
            format!("预校验 {}/{} 字节", verified_bytes, total),
        );
        if current == file_bytes {
            continue;
        }
        all_identical = false;
        loader
            .add_data(addr, file_bytes)
            .map_err(|e| format!("准备烧录数据失败: {e}"))?;
    }

    if all_identical {
        emit_progress(&app, "complete", 1.0, "内容已一致，无需烧录".to_string());
        return Ok(());
    }

    // 进度回调 → "flash-progress" 事件
    let progress_state = Arc::new(Mutex::new(ProgressState::new()));
    let app_clone = app.clone();
    let progress_state_clone = Arc::clone(&progress_state);

    let progress_callback = FlashProgress::new(move |event| {
        let mut state = progress_state_clone.lock();

        let (phase, message) = match event {
            ProgressEvent::FlashLayoutReady { .. } => ("init".to_string(), "Flash 布局准备完成".to_string()),
            ProgressEvent::AddProgressBar { operation, total } => match operation {
                ProgressOperation::Erase => {
                    state.erase_total = total.unwrap_or(0);
                    ("init".to_string(), format!("准备擦除 {} 字节", state.erase_total))
                }
                ProgressOperation::Program => {
                    state.program_total = total.unwrap_or(0);
                    ("init".to_string(), format!("准备编程 {} 字节", state.program_total))
                }
                ProgressOperation::Fill => ("init".to_string(), "准备填充数据".to_string()),
                ProgressOperation::Verify => ("init".to_string(), "准备校验".to_string()),
            },
            ProgressEvent::Started(operation) => match operation {
                ProgressOperation::Fill => ("fill".to_string(), "开始填充数据".to_string()),
                ProgressOperation::Erase => {
                    state.erase_current = 0;
                    ("erase".to_string(), "开始擦除".to_string())
                }
                ProgressOperation::Program => {
                    state.program_current = 0;
                    ("program".to_string(), "开始编程".to_string())
                }
                ProgressOperation::Verify => ("verify".to_string(), "开始校验".to_string()),
            },
            ProgressEvent::Progress { operation, size, .. } => match operation {
                ProgressOperation::Fill => ("fill".to_string(), format!("已填充 {} 字节", size)),
                ProgressOperation::Erase => {
                    state.erase_current += size;
                    state.erase_total = state.erase_current.max(state.erase_total);
                    ("erase".to_string(), format!("已擦除 {} 字节", state.erase_current))
                }
                ProgressOperation::Program => {
                    state.program_current += size;
                    (
                        "program".to_string(),
                        format!("已编程 {}/{} 字节", state.program_current, state.program_total),
                    )
                }
                ProgressOperation::Verify => ("verify".to_string(), format!("已校验 {} 字节", size)),
            },
            ProgressEvent::Failed(operation) => match operation {
                ProgressOperation::Fill => ("fill".to_string(), "填充失败".to_string()),
                ProgressOperation::Erase => ("erase".to_string(), "擦除失败".to_string()),
                ProgressOperation::Program => ("program".to_string(), "编程失败".to_string()),
                ProgressOperation::Verify => ("verify".to_string(), "校验失败".to_string()),
            },
            ProgressEvent::Finished(operation) => match operation {
                ProgressOperation::Fill => ("fill".to_string(), "填充完成".to_string()),
                ProgressOperation::Erase => ("erase".to_string(), "擦除完成".to_string()),
                ProgressOperation::Program => ("program".to_string(), "编程完成".to_string()),
                ProgressOperation::Verify => ("verify".to_string(), "校验完成".to_string()),
            },
            ProgressEvent::DiagnosticMessage { message } => ("info".to_string(), message),
        };

        let progress = state.calculate_progress();
        let _ = app_clone.emit(
            "flash-progress",
            FlashProgressEvent {
                phase,
                progress,
                message,
            },
        );
    });

    let mut download_options = DownloadOptions::default();
    // 扇区擦除：只擦数据段覆盖的扇区，绝不整片擦除（保护 BOOT 与其他槽）
    download_options.do_chip_erase = false;
    download_options.verify = options.verify;
    download_options.progress = progress_callback;

    loader
        .commit(session, download_options)
        .map_err(|e| format!("烧录失败: {e:#}"))?;

    emit_progress(&app, "finishing", 0.95, "烧录完成，正在收尾...".to_string());

    // 烧录完成复位芯片（MCUboot 从 BOOT 重新启动，检测新固件）
    if options.reset_after {
        emit_progress(&app, "reset", 0.98, "正在复位芯片...".to_string());
        let mut core = session.core(0).map_err(|e| format!("访问内核失败: {e}"))?;
        core.reset().map_err(|e| format!("复位失败: {e}"))?;
    }

    emit_progress(&app, "complete", 1.0, "烧录完成".to_string());

    Ok(())
}
