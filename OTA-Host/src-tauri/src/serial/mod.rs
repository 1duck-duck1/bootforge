pub mod local;

pub use local::{list_serial_ports, LocalSerial, SerialPortInfo};

use serde::{Deserialize, Serialize};

/// Serial data source configuration（v1 仅本地串口，保留 tag 结构便于扩展）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SerialConfig {
    #[serde(rename = "local")]
    Local {
        port: String,
        baud_rate: u32,
        #[serde(default = "default_data_bits")]
        data_bits: u8,
        #[serde(default = "default_stop_bits")]
        stop_bits: u8,
        #[serde(default = "default_parity")]
        parity: String,
        #[serde(default = "default_flow_control")]
        flow_control: String,
        /// 打开串口后是否拉高 DTR（默认关）
        #[serde(default)]
        dtr: bool,
        /// 打开串口后是否拉高 RTS（默认关）
        #[serde(default)]
        rts: bool,
    },
}

fn default_data_bits() -> u8 {
    8
}
fn default_stop_bits() -> u8 {
    1
}
fn default_parity() -> String {
    "none".to_string()
}
fn default_flow_control() -> String {
    "none".to_string()
}
