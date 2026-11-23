//! 前端文本导出落盘（串口日志等），避免额外引入 fs 插件权限。
use std::path::Path;

/// 将文本写入指定路径；父目录不存在时自动创建。
#[tauri::command]
pub fn save_text_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败 {}: {e}", parent.display()))?;
        }
    }
    std::fs::write(&path, content).map_err(|e| format!("写入文件失败 {path}: {e}"))
}
