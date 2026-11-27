use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

/// imgtool 签名参数。默认值由前端按本项目（STM32F407 + MCUboot）填充：
/// header 0x200 / slot 0x60000 / align 8 / ECDSA P-256 root key。
#[derive(Debug, Deserialize)]
pub struct SignOptions {
    pub input_path: String,
    pub output_path: String,
    pub version: String,
    pub key_path: String,
    pub header_size: u32,
    pub slot_size: u32,
    pub align: u32,
    pub python: String,
    pub imgtool: String,
    /// 防回滚安全计数器（imgtool --security-counter）。设备开启
    /// MCUBOOT_HW_ROLLBACK_PROT 后该 TLV 为必选项。
    #[serde(default)]
    pub security_counter: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SignResult {
    pub output_path: String,
    pub size: u64,
}

/// 调用 Python imgtool 对固件签名（--pad 填充整槽）。
/// stdout/stderr 逐行通过 "ota-sign-log" 事件推给前端。
#[tauri::command]
pub async fn sign_firmware(options: SignOptions, app: AppHandle) -> Result<SignResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&options.python);
        cmd.arg(&options.imgtool)
            .arg("sign")
            .arg("--key")
            .arg(&options.key_path)
            .arg("--header-size")
            .arg(format!("0x{:x}", options.header_size))
            .arg("--pad-header")
            .arg("--align")
            .arg(format!("{}", options.align))
            .arg("--slot-size")
            .arg(format!("0x{:x}", options.slot_size))
            .arg("--version")
            .arg(&options.version);

        if let Some(counter) = options.security_counter {
            cmd.arg("--security-counter").arg(counter.to_string());
        }

        cmd.arg("--pad")
            .arg(&options.input_path)
            .arg(&options.output_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Windows 上隐藏 python 的控制台窗口
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }

        let counter_log = match options.security_counter {
            Some(counter) => format!(" --security-counter {}", counter),
            None => String::new(),
        };
        let _ = app.emit(
            "ota-sign-log",
            format!(
                "$ python \"{}\" sign --key \"{}\" --header-size 0x{:x} --pad-header --align {} --slot-size 0x{:x} --version {}{} --pad \"{}\" \"{}\"",
                options.imgtool,
                options.key_path,
                options.header_size,
                options.align,
                options.slot_size,
                options.version,
                counter_log,
                options.input_path,
                options.output_path
            ),
        );

        let mut child = cmd.spawn().map_err(|e| format!("启动签名进程失败: {}", e))?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        if let Some(stdout) = stdout {
            let app2 = app.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().map_while(Result::ok) {
                    let _ = app2.emit("ota-sign-log", line);
                }
            });
        }
        if let Some(stderr) = stderr {
            let app2 = app.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    let _ = app2.emit("ota-sign-log", format!("[stderr] {}", line));
                }
            });
        }

        let status = child.wait().map_err(|e| format!("等待签名进程失败: {}", e))?;
        if !status.success() {
            return Err(format!("imgtool 退出码: {}", status.code().unwrap_or(-1)));
        }

        let size = std::fs::metadata(&options.output_path)
            .map_err(|e| format!("读取输出文件失败: {}", e))?
            .len();

        Ok(SignResult {
            output_path: options.output_path,
            size,
        })
    })
    .await
    .map_err(|e| format!("签名任务异常: {}", e))?
}
