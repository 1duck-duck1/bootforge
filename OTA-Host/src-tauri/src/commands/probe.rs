//! 探针枚举与连接管理（参考 OmniProbe 架构）。
//! 探针枚举 = probe-rs Lister + Windows 下官方驱动 J-Link 合并；
//! 连接 = 打开探针 → SWD → 设速度 → attach 到所选芯片（默认 stm32f407vg）。
use crate::state::{AppState, ConnectionInfo};
use probe_rs::{
    architecture::arm::dp::{DpAddress, DpRegisterAddress},
    config::Registry,
    probe::{list::Lister, WireProtocol},
    MemoryInterface, Permissions, Session,
};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, LazyLock};
use tauri::State;

/// 本项目默认目标芯片（probe-rs 内置定义，含 Flash 烧录算法）。
pub const TARGET_NAME: &str = "stm32f407vg";

/// 内置芯片注册表（无需 Pack 导入，STM32F4 系列开箱即用）。
static TARGET_REGISTRY: LazyLock<Registry> = LazyLock::new(Registry::from_builtin_families);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeInfo {
    pub probe_id: String,
    pub identifier: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub serial_number: Option<String>,
    pub probe_type: String,
    pub dap_version: Option<String>,
    pub debug_info: Option<String>,
    #[serde(default)]
    pub connection_hint: Option<String>,
}

fn build_probe_id(vendor_id: u16, product_id: u16, serial_number: &Option<String>) -> String {
    let serial = serial_number.as_deref().unwrap_or("");
    format!("{:04x}:{:04x}:{}", vendor_id, product_id, serial)
}

/// 枚举探针：probe-rs 原生列表 + Windows 官方驱动 J-Link 合并。
fn enumerate_probes() -> Vec<ProbeInfo> {
    let probes = Lister::new().list_all();
    let mut probe_infos: Vec<ProbeInfo> = probes
        .iter()
        .map(|p| {
            let probe_type = format!("{:?}", p.probe_type());
            ProbeInfo {
                probe_id: build_probe_id(p.vendor_id, p.product_id, &p.serial_number),
                identifier: p.identifier.clone(),
                vendor_id: p.vendor_id,
                product_id: p.product_id,
                serial_number: p.serial_number.clone(),
                probe_type,
                dap_version: None,
                debug_info: None,
                connection_hint: None,
            }
        })
        .collect();

    #[cfg(windows)]
    crate::jlink::augment(&mut probe_infos);

    probe_infos
}

#[tauri::command]
pub async fn list_probes() -> Result<Vec<ProbeInfo>, String> {
    tauri::async_runtime::spawn_blocking(enumerate_probes)
        .await
        .map_err(|e| format!("探针枚举异常: {e}"))
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectOptions {
    pub probe_identifier: String,
    /// 目标芯片名（probe-rs 内置注册表），缺省为 stm32f407vg
    #[serde(default)]
    pub target: Option<String>,
    /// SWD 时钟速度（kHz），默认 4000
    #[serde(default)]
    pub clock_speed_khz: Option<u32>,
}

/// 连接结果（前端展示用）
#[derive(Debug, Clone, Serialize)]
pub struct TargetInfo {
    pub name: String,
    pub chip_id: Option<u32>,
    pub target_idcode: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChipInfo {
    pub name: String,
    pub vendor: String,
    pub family: String,
    pub cores: Vec<CoreInfo>,
    pub memory_regions: Vec<MemoryRegionInfo>,
    pub flash_algorithms: Vec<FlashAlgorithmInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreInfo {
    pub name: String,
    pub core_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRegionInfo {
    pub name: String,
    pub kind: String,
    pub address: u64,
    pub size: u64,
    pub page_size: Option<u64>,
    pub sector_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlashAlgorithmInfo {
    pub name: String,
    pub default: bool,
    pub load_address: u64,
    pub data_section_offset: u64,
}

/// 按关键字搜索 probe-rs 内置芯片（供前端选择目标芯片）
#[tauri::command]
pub async fn search_chips(query: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let needle = query.trim().to_lowercase();
        let mut names: Vec<String> = TARGET_REGISTRY
            .families()
            .iter()
            .flat_map(|family| family.variants().iter())
            .map(|variant| variant.name.clone())
            .filter(|name| needle.is_empty() || name.to_lowercase().contains(&needle))
            .collect();
        names.sort_unstable();
        names.dedup();
        names.truncate(50);
        names
    })
    .await
    .map_err(|e| format!("芯片搜索异常: {e}"))
}

/// 读取芯片的内存映射与烧录算法（类似 OmniProbe 的芯片信息卡）
#[tauri::command]
pub async fn get_chip_info(chip_name: String) -> Result<ChipInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = TARGET_REGISTRY
            .get_target_by_name(&chip_name)
            .map_err(|e| format!("未找到芯片 '{chip_name}': {e}"))?;

        Ok(ChipInfo {
            name: target.name.clone(),
            vendor: String::new(),
            family: String::new(),
            cores: target
                .cores
                .iter()
                .map(|core| CoreInfo {
                    name: core.name.clone(),
                    core_type: format!("{:?}", core.core_type),
                })
                .collect(),
            memory_regions: target
                .memory_map
                .iter()
                .map(|region| match region {
                    probe_rs::config::MemoryRegion::Ram(ram) => MemoryRegionInfo {
                        name: ram.name.clone().unwrap_or_default(),
                        kind: "RAM".to_string(),
                        address: ram.range.start,
                        size: ram.range.end - ram.range.start,
                        page_size: None,
                        sector_size: None,
                    },
                    probe_rs::config::MemoryRegion::Nvm(nvm) => MemoryRegionInfo {
                        name: nvm.name.clone().unwrap_or_default(),
                        kind: "Flash".to_string(),
                        address: nvm.range.start,
                        size: nvm.range.end - nvm.range.start,
                        page_size: None,
                        sector_size: None,
                    },
                    probe_rs::config::MemoryRegion::Generic(generic) => MemoryRegionInfo {
                        name: generic.name.clone().unwrap_or_default(),
                        kind: "Generic".to_string(),
                        address: generic.range.start,
                        size: generic.range.end - generic.range.start,
                        page_size: None,
                        sector_size: None,
                    },
                })
                .collect(),
            flash_algorithms: target
                .flash_algorithms
                .iter()
                .map(|algorithm| FlashAlgorithmInfo {
                    name: algorithm.name.clone(),
                    default: algorithm.default,
                    load_address: algorithm.load_address.unwrap_or(0),
                    data_section_offset: algorithm.data_section_offset,
                })
                .collect(),
        })
    })
    .await
    .map_err(|e| format!("读取芯片信息异常: {e}"))?
}

fn open_selected_probe(info: &ProbeInfo) -> Result<probe_rs::probe::Probe, String> {
    // 官方驱动（非 WinUSB）的 J-Link 走 JLinkARM.dll FFI 路径。
    #[cfg(windows)]
    if let Some(serial) = crate::jlink::serial_from_id(&info.probe_id) {
        if crate::jlink::runtime_available() {
            return crate::jlink::open(serial);
        }
    }

    // 其余探针（含已切 WinUSB 的 J-Link）走 probe-rs 原生打开路径。
    let raw = Lister::new().list_all().into_iter().find(|probe| {
        build_probe_id(probe.vendor_id, probe.product_id, &probe.serial_number) == info.probe_id
            || (probe.vendor_id == info.vendor_id
                && probe.product_id == info.product_id
                && probe
                    .serial_number
                    .as_deref()
                    .and_then(|s| s.parse::<u32>().ok())
                    .zip(info.serial_number.as_deref().and_then(|s| s.parse::<u32>().ok()))
                    .is_some_and(|(a, b)| a == b))
    });
    raw.ok_or_else(|| "探针已断开，请重新插入后重试。".to_string())
        .and_then(|probe| probe.open().map_err(|error| error.to_string()))
        .map_err(|error| {
            #[cfg(windows)]
            if crate::jlink::serial_from_id(&info.probe_id).is_some() {
                let hint = if crate::jlink::runtime_available() {
                    "当前官方驱动接入仅支持 Cortex-M 芯片的 SWD 连接，请检查芯片和接口设置。".into()
                } else {
                    crate::jlink::missing_runtime_message()
                };
                return hint;
            }
            format!("打开探针失败: {error}")
        })
}

/// 打开探针并 attach 到所选芯片。同步阻塞，由命令层放阻塞线程执行。
fn open_session(options: &ConnectOptions) -> Result<(Session, ConnectionInfo), String> {
    let probes = enumerate_probes();
    let mut matches = probes
        .iter()
        .filter(|p| p.probe_id == options.probe_identifier || p.identifier == options.probe_identifier);
    let probe_info = matches
        .next()
        .ok_or_else(|| "未找到指定的探针，请刷新列表".to_string())?;
    if matches.next().is_some() {
        return Err("有多个同名探针，请刷新列表并按序列号重新选择。".into());
    }

    let target_name = options
        .target
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(TARGET_NAME);

    let target = TARGET_REGISTRY
        .get_target_by_name(target_name)
        .map_err(|e| format!("无法加载芯片定义 '{target_name}': {e}"))?;

    let mut probe = open_selected_probe(probe_info)?;

    probe
        .select_protocol(WireProtocol::Swd)
        .map_err(|e| format!("设置 SWD 协议失败: {e}"))?;

    let speed_khz = options.clock_speed_khz.unwrap_or(4000);
    probe
        .set_speed(speed_khz)
        .map_err(|e| format!("设置时钟速度失败 ({speed_khz} kHz): {e}"))?;

    // target 已从内置注册表解析，attach 无需再查额外注册表。
    let empty_registry = Registry::new();
    let mut session = probe
        .attach_with_registry(target, Permissions::default(), &empty_registry)
        .map_err(|e| {
            format!("无法连接到芯片 '{target_name}': {e}。请检查: 1) 探针与板卡接线 2) 目标供电 3) SWD 接口")
        })?;

    let chip_id = read_chip_id(&mut session);
    let target_idcode = read_dp_idcode(&mut session);
    eprintln!(
        "已连接 {target_name}，芯片ID: {:08X?}，调试端口ID: {:08X?}",
        chip_id, target_idcode
    );

    let connection_info = ConnectionInfo {
        probe_name: probe_info.identifier.clone(),
        probe_serial: probe_info.serial_number.clone(),
        target_name: target_name.to_string(),
        chip_id,
        target_idcode,
    };

    Ok((session, connection_info))
}

/// 读取芯片 IDCODE（DBGMCU_IDCODE，STM32F4 位于 0xE0042000）
fn read_chip_id(session: &mut Session) -> Option<u32> {
    let mut core = session.core(0).ok()?;
    // Common chip IDCODE address list
    let id_addresses: &[(u64, &str)] = &[
        (0xE0042000, "STM32 DBGMCU_IDCODE"),   // Most STM32 chips
        (0x40015800, "STM32G0/G4 DBG_IDCODE"), // STM32G0/G4 series
        (0x1FFFF7E8, "STM32 UID"),             // Backup: Unique ID
    ];
    for (addr, _name) in id_addresses {
        if let Ok(id) = core.read_word_32(*addr) {
            if id != 0 && id != 0xFFFFFFFF {
                return Some(id);
            }
        }
    }
    None
}

/// 读取调试端口 DPIDR
fn read_dp_idcode(session: &mut Session) -> Option<u32> {
    if let Ok(interface) = session.get_arm_interface() {
        let dp_addr = DpAddress::Default;
        let reg_addr = DpRegisterAddress {
            address: 0x0,
            bank: None,
        };
        if let Ok(dpidr) = interface.read_raw_dp_register(dp_addr, reg_addr) {
            if dpidr != 0 && dpidr != 0xFFFFFFFF {
                return Some(dpidr);
            }
        }
    }
    None
}

/// 替换连接槽位：先关旧连接，再建新连接。
#[tauri::command]
pub async fn connect_target(
    options: ConnectOptions,
    state: State<'_, AppState>,
) -> Result<TargetInfo, String> {
    let session_slot = Arc::clone(&state.session);
    let info_slot = Arc::clone(&state.connection_info);
    tauri::async_runtime::spawn_blocking(move || {
        // 释放旧连接（连接信息一并清空）
        *info_slot.lock() = None;
        drop(session_slot.lock().take());

        let (session, connection_info) = open_session(&options)?;
        let target_info = TargetInfo {
            name: connection_info.target_name.clone(),
            chip_id: connection_info.chip_id,
            target_idcode: connection_info.target_idcode,
        };
        *session_slot.lock() = Some(session);
        *info_slot.lock() = Some(connection_info);
        Ok(target_info)
    })
    .await
    .map_err(|e| format!("连接任务异常: {e}"))?
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>) -> Result<(), String> {
    // 先停 RTT 轮询，避免它继续抢会话锁
    state.rtt_state.run.stop();
    let session_slot = Arc::clone(&state.session);
    let info_slot = Arc::clone(&state.connection_info);
    tauri::async_runtime::spawn_blocking(move || {
        let previous = session_slot.lock().take();
        if let Some(mut session) = previous {
            // 断开前恢复芯片运行
            if let Ok(mut core) = session.core(0) {
                let _ = core.run();
            }
        }
        *info_slot.lock() = None;
        Ok(())
    })
    .await
    .map_err(|e| format!("断开任务异常: {e}"))?
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionStatus {
    pub connected: bool,
    pub info: Option<ConnectionInfo>,
}

/// 查询连接状态不能阻塞等 session 锁：烧录期间锁会被持有数分钟，
/// 拿不到锁就以连接信息为准（连接期间一直存在）。
#[tauri::command]
pub async fn get_connection_status(state: State<'_, AppState>) -> Result<ConnectionStatus, String> {
    let info = state.connection_info.lock().clone();
    let connected = match state.session.try_lock() {
        Some(guard) => guard.is_some(),
        None => info.is_some(),
    };
    Ok(ConnectionStatus { connected, info })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 内置注册表必须包含本项目目标芯片（含 Flash 烧录算法），否则连接必然失败。
    #[test]
    fn builtin_registry_contains_stm32f407vg() {
        let target = TARGET_REGISTRY
            .get_target_by_name(TARGET_NAME)
            .unwrap_or_else(|e| panic!("内置注册表缺少 {TARGET_NAME}: {e}"));
        assert!(
            target.flash_algorithms.iter().any(|a| a.name.to_lowercase().contains("stm32f4")),
            "缺少 STM32F4 系列烧录算法"
        );
    }
}
