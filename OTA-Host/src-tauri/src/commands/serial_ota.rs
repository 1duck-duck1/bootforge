//! 串口 OTA 命令入口。
//!
//! OTA 会独占串口：先停掉普通接收线程，协议在阻塞线程里按帧收发；
//! 前端通过 `serial-ota-progress` 事件展示阶段与进度。

use crate::serial::ota::{self, DeviceStatus, SerialOtaResult};
use crate::state::{AppState, SerialOtaState};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, State};

struct RunningGuard(Arc<SerialOtaState>);

impl Drop for RunningGuard {
    fn drop(&mut self) {
        self.0.running.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub async fn serial_ota_flash(
    app: AppHandle,
    image_path: String,
    deny_downgrade: bool,
    state: State<'_, AppState>,
) -> Result<SerialOtaResult, String> {
    if state.serial_ota.running.swap(true, Ordering::AcqRel) {
        return Err("已有串口 OTA 正在进行".to_string());
    }
    state.serial_ota.cancel.store(false, Ordering::Release);
    let _guard = RunningGuard(Arc::clone(&state.serial_ota));

    if !state.serial_state.is_connected() {
        return Err("串口未连接，请先连接设备 USART2".to_string());
    }

    // 停掉普通接收线程，OTA 期间由协议引擎独占收发
    state.serial_state.run.stop();
    let serial = Arc::clone(&state.serial_state);
    let ota_state = Arc::clone(&state.serial_ota);

    tokio::task::spawn_blocking(move || {
        // 读线程最多阻塞 50ms，留出余量确保它已退出
        std::thread::sleep(Duration::from_millis(120));
        ota::run(&app, &serial, &image_path, deny_downgrade, &ota_state.cancel)
    })
    .await
    .map_err(|e| format!("串口 OTA 任务异常: {e}"))?
}

#[tauri::command]
pub fn serial_ota_abort(state: State<'_, AppState>) -> Result<(), String> {
    state.serial_ota.cancel.store(true, Ordering::Release);
    Ok(())
}

/// 读取设备信息（协议/UID/双槽版本/槽容量/交换状态）。
/// 会先让应用复位进入 Bootloader 查询，结束后发 EXIT 立即返回应用，不擦写 Flash。
#[tauri::command]
pub async fn serial_ota_device_info(
    state: State<'_, AppState>,
) -> Result<DeviceStatus, String> {
    if state.serial_ota.running.swap(true, Ordering::AcqRel) {
        return Err("已有串口 OTA 任务正在进行".to_string());
    }
    state.serial_ota.cancel.store(false, Ordering::Release);
    let _guard = RunningGuard(Arc::clone(&state.serial_ota));

    if !state.serial_state.is_connected() {
        return Err("串口未连接，请先连接设备 USART2".to_string());
    }

    // 停掉普通接收线程，查询期间由协议引擎独占收发
    state.serial_state.run.stop();
    let serial = Arc::clone(&state.serial_state);
    let ota_state = Arc::clone(&state.serial_ota);

    tokio::task::spawn_blocking(move || {
        // 读线程最多阻塞 50ms，留出余量确保它已退出
        std::thread::sleep(Duration::from_millis(120));
        ota::read_device_info(&serial, &ota_state.cancel)
    })
    .await
    .map_err(|e| format!("设备信息读取任务异常: {e}"))?
}
