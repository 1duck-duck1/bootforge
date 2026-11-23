pub mod commands;
#[cfg(windows)]
mod jlink;
pub mod serial;
pub mod state;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(AppState::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 串口命令
            commands::serial::list_serial_ports_cmd,
            commands::serial::connect_serial,
            commands::serial::disconnect_serial,
            commands::serial::write_serial,
            commands::serial::write_serial_string,
            commands::serial::start_serial,
            commands::serial::stop_serial,
            // OTA 签名命令
            commands::ota::sign_firmware,
            // 探针连接命令
            commands::probe::list_probes,
            commands::probe::connect_target,
            commands::probe::disconnect,
            commands::probe::get_connection_status,
            // probe-rs 烧录命令
            commands::flash::flash_firmware,
            // RTT 命令
            commands::rtt::start_rtt,
            commands::rtt::stop_rtt,
            commands::rtt::write_rtt,
            // 镜像校验 / 槽位状态 / 文本导出
            commands::image::inspect_image,
            commands::image::read_slot_status,
            commands::fs::save_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
