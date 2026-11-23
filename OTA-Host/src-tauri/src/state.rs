use parking_lot::Mutex;
use probe_rs::Session;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// 采集循环（串口读线程）的运行代次。
///
/// 每次启动分配新代次，停止时代次也会前进；旧循环发现代次变化就退出，
/// 这样快速"停止→启动"时不会出现新旧两个循环同时读同一个数据源，
/// 旧循环退出时也无法把新循环的状态改成已停止。
/// 低位表示是否运行，其余位是代次，放在同一个原子量里保证读写一致。
#[derive(Default)]
pub struct RunGeneration(AtomicU64);

impl RunGeneration {
    /// 开始新一轮运行，返回本轮代次
    pub fn start(&self) -> u64 {
        let previous = self.update(|v| Some(((v >> 1) + 1) << 1 | 1)).unwrap_or_default();
        (previous >> 1) + 1
    }

    /// 停止当前运行（任何代次的循环都会在下一轮检查时退出）
    pub fn stop(&self) {
        let _ = self.update(|v| Some(((v >> 1) + 1) << 1));
    }

    /// 原子地读-改-写，返回旧值；`f` 返回 None 时放弃并返回当前值。
    fn update(&self, f: impl Fn(u64) -> Option<u64>) -> Result<u64, u64> {
        let mut current = self.0.load(Ordering::SeqCst);
        loop {
            let next = f(current).ok_or(current)?;
            match self
                .0
                .compare_exchange_weak(current, next, Ordering::SeqCst, Ordering::SeqCst)
            {
                Ok(previous) => return Ok(previous),
                Err(actual) => current = actual,
            }
        }
    }

    pub fn is_running(&self) -> bool {
        self.0.load(Ordering::SeqCst) & 1 == 1
    }

    /// 该代次是否仍是正在运行的那一轮
    pub fn is_current(&self, generation: u64) -> bool {
        self.0.load(Ordering::SeqCst) == generation << 1 | 1
    }

    /// 循环自行结束时调用：只有仍是当前代次才会标记为停止
    pub fn finish(&self, generation: u64) -> bool {
        self.0
            .compare_exchange(generation << 1 | 1, generation << 1, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// 仅在没有运行时启动：扫描控制块可能耗时数秒，期间重复启动直接拒绝
    pub fn try_start(&self) -> Option<u64> {
        let mut current = self.0.load(Ordering::SeqCst);
        loop {
            if current & 1 == 1 {
                return None;
            }
            let next = (current >> 1) + 1;
            match self.0.compare_exchange_weak(
                current,
                next << 1 | 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => return Some(next),
                Err(actual) => current = actual,
            }
        }
    }
}

/// RTT 下行发送队列：目标端读取速度可能低于发送速度，先入队由轮询线程逐轮写出
#[derive(Default)]
pub struct RttDownQueue {
    pub channels: Vec<usize>,
    pub pending: VecDeque<(usize, Vec<u8>)>,
}

impl RttDownQueue {
    pub fn reset(&mut self, channels: Vec<usize>) {
        self.channels = channels;
        self.pending.clear();
    }

    pub fn pending_bytes(&self) -> usize {
        self.pending.iter().map(|(_, data)| data.len()).sum()
    }
}

/// RTT 运行状态（与烧录共用同一条 probe-rs 会话）
#[derive(Default)]
pub struct RttState {
    pub run: RunGeneration,
    pub down: Mutex<RttDownQueue>,
}

impl RttState {
    pub fn is_running(&self) -> bool {
        self.run.is_running()
    }
}

/// Serial connection statistics
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SerialStats {
    pub bytes_received: u64,
    pub bytes_sent: u64,
}

/// Data source trait for serial communication (synchronous)
pub trait DataSource: Send {
    fn connect(&mut self) -> Result<(), String>;
    fn disconnect(&mut self) -> Result<(), String>;
    fn write(&mut self, data: &[u8]) -> Result<usize, String>;
    fn read(&mut self, buf: &mut [u8]) -> Result<usize, String>;
    fn is_connected(&self) -> bool;
    fn name(&self) -> String;
    fn stats(&self) -> SerialStats;
    fn reset_stats(&mut self);
}

/// Serial port runtime state
pub struct SerialState {
    /// 读线程运行代次
    pub run: RunGeneration,
    /// Data source instance
    pub datasource: Mutex<Option<Box<dyn DataSource>>>,
}

impl Default for SerialState {
    fn default() -> Self {
        Self {
            run: RunGeneration::default(),
            datasource: Mutex::new(None),
        }
    }
}

impl SerialState {
    pub fn is_running(&self) -> bool {
        self.run.is_running()
    }

    pub fn is_connected(&self) -> bool {
        self.datasource
            .lock()
            .as_ref()
            .map(|ds| ds.is_connected())
            .unwrap_or(false)
    }
}

/// 调试探针连接信息（连接成功后展示用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionInfo {
    pub probe_name: String,
    pub probe_serial: Option<String>,
    pub target_name: String,
    pub chip_id: Option<u32>,
    pub target_idcode: Option<u32>,
}

/// Application State
pub struct AppState {
    pub serial_state: Arc<SerialState>,
    /// 探针会话槽位：连接时放入，断开时取出。
    /// 烧录期间锁会被长时间持有，查状态须用 try_lock。
    pub session: Arc<Mutex<Option<Session>>>,
    pub connection_info: Arc<Mutex<Option<ConnectionInfo>>>,
    pub rtt_state: Arc<RttState>,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    pub fn new() -> Self {
        Self {
            serial_state: Arc::new(SerialState::default()),
            session: Arc::new(Mutex::new(None)),
            connection_info: Arc::new(Mutex::new(None)),
            rtt_state: Arc::new(RttState::default()),
        }
    }
}
