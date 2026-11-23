//! MCUboot 镜像头 / TLV / 槽位 trailer 解析。
//!
//! 镜像布局（所有字段小端）：
//!   image_header(32B) + 镜像体 + [受保护 TLV 区] + [非受保护 TLV 区]
//! TLV 区：magic(2B) + total(2B) + 若干 TLV(type 2B + len 2B + value)，value 按 4 字节对齐。
//! 哈希 TLV 覆盖镜像头 + 镜像体 + 受保护 TLV 区。
//!
//! 槽位 trailer（BOOT_MAX_ALIGN = 8）位于槽尾，从后往前：
//!   magic[16] / image_ok[8] / copy_done[8] / swap_info[8]，
//! 每个 8 字节块只有首字节有效（1 = SET，3 = UNSET，其余为坏值）。
use crate::state::AppState;
use probe_rs::MemoryInterface;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha384, Sha512};
use tauri::State;

const IMAGE_MAGIC: u32 = 0x96f3_b83d;
const IMAGE_HEADER_SIZE: usize = 32;
const IMAGE_TLV_INFO_MAGIC: u16 = 0x6907;
const IMAGE_TLV_PROT_INFO_MAGIC: u16 = 0x6908;
const TLV_ALIGN: usize = 4;
/// 槽尾 trailer 总长度：swap_info(8) + copy_done(8) + image_ok(8) + magic(16)
const TRAILER_SIZE: usize = 40;
/// MCUboot 镜像 trailer 魔数（BOOT_MAX_ALIGN = 8）
const BOOT_MAGIC: [u8; 16] = [
    0x77, 0xc2, 0x95, 0xf3, 0x60, 0xd2, 0xef, 0x7f, 0x35, 0x52, 0x50, 0x0f, 0x2c, 0xb6, 0x79, 0x80,
];

#[derive(Debug, Clone, Serialize)]
pub struct ImageTlv {
    pub tlv_type: u16,
    pub name: String,
    pub len: u32,
    pub value: String,
}

/// 镜像解析结果。结构不合法时 `valid = false`，其余字段尽量填充便于排查。
#[derive(Debug, Clone, Serialize)]
pub struct ImageInfo {
    pub path: String,
    pub file_size: u64,
    pub magic: u32,
    pub valid: bool,
    pub version: Option<String>,
    pub load_addr: u32,
    pub header_size: u16,
    pub protect_tlv_size: u16,
    pub image_size: u32,
    pub flags: u32,
    pub hash_algorithm: Option<String>,
    pub hash_tlv: Option<String>,
    pub computed_hash: Option<String>,
    pub hash_match: Option<bool>,
    pub signature: Option<String>,
    pub keyhash: Option<String>,
    pub security_counter: Option<u32>,
    pub tlvs: Vec<ImageTlv>,
    pub message: String,
}

struct RawTlv {
    tlv_type: u16,
    value: Vec<u8>,
}

fn le_u16(data: &[u8], offset: usize) -> Option<u16> {
    data.get(offset..offset + 2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
}

fn le_u32(data: &[u8], offset: usize) -> Option<u32> {
    data.get(offset..offset + 4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

fn align_up(value: usize, align: usize) -> usize {
    (value + align - 1) & !(align - 1)
}

fn hex(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len() * 2);
    for byte in data {
        out.push_str(&format!("{byte:02X}"));
    }
    out
}

fn tlv_name(tlv_type: u16) -> &'static str {
    match tlv_type {
        0x01 => "KEYHASH",
        0x10 => "SHA256",
        0x11 => "SHA384",
        0x12 => "SHA512",
        0x20 => "RSA2048-PSS",
        0x21 => "ECDSA224",
        0x22 => "ECDSA-P256",
        0x23 => "RSA3072-PSS",
        0x24 => "ED25519",
        0x25 => "SIG-PURE",
        0x30 => "ENC-RSA2048",
        0x31 => "ENC-KW",
        0x32 => "ENC-EC256",
        0x33 => "ENC-X25519",
        0x34 => "ENC-X25519-SHA512",
        0x40 => "DEPENDENCY",
        0x50 => "SEC-CNT",
        0x60 => "BOOT-RECORD",
        0x70 => "DECOMP-SIZE",
        0x71 => "DECOMP-SHA",
        0x72 => "DECOMP-SIG",
        0x73 => "COMP-DEC-SIZE",
        0x74 => "UUID-VID",
        0x75 => "UUID-CID",
        _ => "UNKNOWN",
    }
}

/// 解析一个 TLV 区，返回其中所有 TLV；区域魔法数或长度非法时返回错误说明。
fn parse_tlv_area(
    data: &[u8],
    start: usize,
    expected_magic: u16,
    out: &mut Vec<RawTlv>,
) -> Result<(), String> {
    if start + 4 > data.len() {
        return Err(format!("TLV 区起点 0x{start:X} 超出文件范围"));
    }
    let magic = le_u16(data, start).unwrap_or(0);
    if magic != expected_magic {
        return Err(format!(
            "TLV 区魔数 0x{magic:04X} 不符（期望 0x{expected_magic:04X}）"
        ));
    }
    let total = le_u16(data, start + 2).unwrap_or(0) as usize;
    if total < 4 {
        return Err(format!("TLV 区长度 {total} 非法"));
    }
    let end = start
        .checked_add(total)
        .filter(|end| *end <= data.len())
        .ok_or_else(|| format!("TLV 区结束位置 0x{:X} 超出文件范围", start + total))?;

    let mut offset = start + 4;
    while offset + 4 <= end {
        let tlv_type = le_u16(data, offset).unwrap_or(0);
        let len = le_u16(data, offset + 2).unwrap_or(0) as usize;
        offset += 4;
        let value_end = offset
            .checked_add(len)
            .filter(|value_end| *value_end <= end)
            .ok_or_else(|| format!("TLV 0x{tlv_type:04X} 长度 {len} 越界"))?;
        out.push(RawTlv {
            tlv_type,
            value: data[offset..value_end].to_vec(),
        });
        // TLV 数据按 4 字节对齐，对齐基准是 TLV 区起点
        offset = start + align_up(value_end - start, TLV_ALIGN);
    }
    Ok(())
}

pub fn parse_image(path: &str) -> Result<ImageInfo, String> {
    let data = std::fs::read(path).map_err(|e| format!("读取固件失败: {e}"))?;
    let file_size = data.len() as u64;

    let mut info = ImageInfo {
        path: path.to_string(),
        file_size,
        magic: 0,
        valid: false,
        version: None,
        load_addr: 0,
        header_size: 0,
        protect_tlv_size: 0,
        image_size: 0,
        flags: 0,
        hash_algorithm: None,
        hash_tlv: None,
        computed_hash: None,
        hash_match: None,
        signature: None,
        keyhash: None,
        security_counter: None,
        tlvs: Vec::new(),
        message: String::new(),
    };

    if data.len() < IMAGE_HEADER_SIZE {
        info.message = format!("文件仅 {} 字节，不足 MCUboot 镜像头 32 字节", data.len());
        return Ok(info);
    }

    info.magic = le_u32(&data, 0).unwrap_or(0);
    if info.magic != IMAGE_MAGIC {
        info.message = format!(
            "镜像魔数 0x{:08X} 不符（期望 0x{:08X}），不是 imgtool 签名产物",
            info.magic, IMAGE_MAGIC
        );
        return Ok(info);
    }

    info.load_addr = le_u32(&data, 4).unwrap_or(0);
    info.header_size = le_u16(&data, 8).unwrap_or(0);
    info.protect_tlv_size = le_u16(&data, 10).unwrap_or(0);
    info.image_size = le_u32(&data, 12).unwrap_or(0);
    info.flags = le_u32(&data, 16).unwrap_or(0);
    let major = data[20];
    let minor = data[21];
    let revision = le_u16(&data, 22).unwrap_or(0);
    let build = le_u32(&data, 24).unwrap_or(0);
    info.version = Some(format!("{major}.{minor}.{revision}+{build}"));

    let header_size = info.header_size as usize;
    let image_size = info.image_size as usize;
    if header_size < IMAGE_HEADER_SIZE {
        info.message = format!("镜像头大小 {header_size} 小于 32 字节");
        return Ok(info);
    }
    let image_end = match header_size
        .checked_add(image_size)
        .filter(|end| *end <= data.len())
    {
        Some(end) => end,
        None => {
            info.message = format!(
                "镜像体范围 0x{header_size:X}..0x{:X} 超出文件大小 0x{:X}",
                header_size + image_size,
                data.len()
            );
            return Ok(info);
        }
    };
    let hash_end = match image_end
        .checked_add(info.protect_tlv_size as usize)
        .filter(|end| *end <= data.len())
    {
        Some(end) => end,
        None => {
            info.message = "受保护 TLV 区超出文件范围".to_string();
            return Ok(info);
        }
    };

    let mut raw_tlvs = Vec::new();
    if info.protect_tlv_size > 0 {
        if let Err(error) = parse_tlv_area(&data, image_end, IMAGE_TLV_PROT_INFO_MAGIC, &mut raw_tlvs)
        {
            info.message = format!("受保护 {error}");
            return Ok(info);
        }
    }
    if let Err(error) = parse_tlv_area(&data, hash_end, IMAGE_TLV_INFO_MAGIC, &mut raw_tlvs) {
        info.message = error;
        return Ok(info);
    }

    info.valid = true;

    // 哈希 TLV：SHA256 / SHA384 / SHA512，用于和本地重算结果比较
    let hash_tlv = raw_tlvs
        .iter()
        .find(|tlv| matches!(tlv.tlv_type, 0x10 | 0x11 | 0x12));
    if let Some(tlv) = hash_tlv {
        let expected = match tlv.tlv_type {
            0x10 => Sha256::digest(&data[..hash_end]).to_vec(),
            0x11 => Sha384::digest(&data[..hash_end]).to_vec(),
            _ => Sha512::digest(&data[..hash_end]).to_vec(),
        };
        info.hash_algorithm = Some(tlv_name(tlv.tlv_type).to_string());
        info.hash_tlv = Some(hex(&tlv.value));
        info.computed_hash = Some(hex(&expected));
        info.hash_match = Some(tlv.value == expected);
    }

    if let Some(tlv) = raw_tlvs.iter().find(|tlv| tlv.tlv_type == 0x01) {
        info.keyhash = Some(hex(&tlv.value));
    }
    if let Some(tlv) = raw_tlvs.iter().find(|tlv| tlv.tlv_type == 0x50) {
        info.security_counter = le_u32(&tlv.value, 0);
    }
    if let Some(tlv) = raw_tlvs
        .iter()
        .find(|tlv| matches!(tlv.tlv_type, 0x20 | 0x21 | 0x22 | 0x23 | 0x24))
    {
        info.signature = Some(format!("{} ({} 字节)", tlv_name(tlv.tlv_type), tlv.value.len()));
    }

    info.tlvs = raw_tlvs
        .into_iter()
        .map(|tlv| {
            let value = match tlv.tlv_type {
                0x50 => le_u32(&tlv.value, 0)
                    .map(|value| format!("{value}"))
                    .unwrap_or_else(|| hex(&tlv.value)),
                _ if tlv.value.len() <= 64 => hex(&tlv.value),
                _ => format!("{}…（{} 字节）", hex(&tlv.value[..32]), tlv.value.len()),
            };
            ImageTlv {
                tlv_type: tlv.tlv_type,
                name: tlv_name(tlv.tlv_type).to_string(),
                len: tlv.value.len() as u32,
                value,
            }
        })
        .collect();

    info.message = match info.hash_match {
        Some(true) => "镜像结构有效，哈希校验通过".to_string(),
        Some(false) => "镜像哈希不匹配，文件可能被篡改或损坏".to_string(),
        None => "镜像结构有效，但缺少哈希 TLV".to_string(),
    };

    Ok(info)
}

/// 解析本地固件（.bin），检查 MCUboot 镜像头、TLV 与哈希是否匹配。
#[tauri::command]
pub async fn inspect_image(path: String) -> Result<ImageInfo, String> {
    tauri::async_runtime::spawn_blocking(move || parse_image(&path))
        .await
        .map_err(|e| format!("镜像解析任务异常: {e}"))?
}

#[derive(Debug, Clone, Deserialize)]
pub struct SlotQuery {
    pub name: String,
    pub address: u64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SlotStatus {
    pub name: String,
    pub address: u64,
    pub size: u64,
    pub header_valid: bool,
    pub version: Option<String>,
    pub image_size: Option<u32>,
    pub header_size: Option<u16>,
    pub trailer_valid: bool,
    pub image_ok: Option<bool>,
    pub copy_done: Option<bool>,
    pub swap_info: Option<u32>,
    pub swap_state: String,
    pub message: String,
}

/// trailer 标志字节解码：1 = SET，3 = UNSET，其余值视为坏值。
fn decode_flag(byte: u8) -> Option<bool> {
    match byte {
        1 => Some(true),
        3 => Some(false),
        _ => None,
    }
}

fn read_slot(session: &mut probe_rs::Session, query: &SlotQuery) -> Result<SlotStatus, String> {
    if query.size < TRAILER_SIZE as u64 {
        return Err(format!("槽 {} 大小不足 {TRAILER_SIZE} 字节", query.name));
    }

    let mut core = session
        .core(0)
        .map_err(|e| format!("访问内核失败: {e}"))?;

    let mut header = [0u8; IMAGE_HEADER_SIZE];
    core.read(query.address, &mut header)
        .map_err(|e| format!("读取 {} 镜像头失败: {e}", query.name))?;
    let magic = le_u32(&header, 0).unwrap_or(0);
    let header_valid = magic == IMAGE_MAGIC;

    let version = if header_valid {
        Some(format!(
            "{}.{}.{}+{}",
            header[20],
            header[21],
            le_u16(&header, 22).unwrap_or(0),
            le_u32(&header, 24).unwrap_or(0)
        ))
    } else {
        None
    };

    let trailer_address = query.address + query.size - TRAILER_SIZE as u64;
    let mut trailer = [0u8; TRAILER_SIZE];
    core.read(trailer_address, &mut trailer)
        .map_err(|e| format!("读取 {} trailer 失败: {e}", query.name))?;

    let trailer_valid = trailer[24..40] == BOOT_MAGIC;
    let swap_raw = trailer[0];
    let swap_info = if trailer_valid { Some(swap_raw as u32) } else { None };
    let swap_state = match swap_raw {
        1 => "none（无待处理交换）",
        2 => "test（测试升级已完成，待确认）",
        3 => "perm（永久升级）",
        4 => "revert（回滚中）",
        5 => "fail（交换失败）",
        _ => "unset（无交换记录）",
    }
    .to_string();

    let message = if header_valid && trailer_valid {
        "有效镜像，trailer 已初始化".to_string()
    } else if header_valid {
        "有效镜像，尚未执行过 swap（trailer 未初始化）".to_string()
    } else if magic == 0xFFFF_FFFF {
        "空槽（擦除态）".to_string()
    } else {
        format!("无效镜像头（魔数 0x{magic:08X}）")
    };

    Ok(SlotStatus {
        name: query.name.clone(),
        address: query.address,
        size: query.size,
        header_valid,
        version,
        image_size: header_valid.then(|| le_u32(&header, 12).unwrap_or(0)),
        header_size: header_valid.then(|| le_u16(&header, 8).unwrap_or(0)),
        trailer_valid,
        image_ok: trailer_valid.then(|| decode_flag(trailer[16])).flatten(),
        copy_done: trailer_valid.then(|| decode_flag(trailer[8])).flatten(),
        swap_info,
        swap_state,
        message,
    })
}

/// 读取设备 Primary / Secondary 槽的镜像头与 trailer 状态（需先连接探针）。
#[tauri::command]
pub async fn read_slot_status(
    slots: Vec<SlotQuery>,
    state: State<'_, AppState>,
) -> Result<Vec<SlotStatus>, String> {
    let session_slot = state.session.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = session_slot
            .try_lock()
            .ok_or_else(|| "烧录进行中，请稍后读取槽位信息".to_string())?;
        let session = guard
            .as_mut()
            .ok_or_else(|| "尚未连接探针，请先连接".to_string())?;
        slots.iter().map(|query| read_slot(session, query)).collect()
    })
    .await
    .map_err(|e| format!("槽位读取任务异常: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_image(version: (u8, u8, u16, u32), corrupt: bool) -> Vec<u8> {
        const HEADER_SIZE: usize = 0x200;
        let payload = vec![0x5Au8; 128];
        let mut data = vec![0u8; HEADER_SIZE];
        data[0..4].copy_from_slice(&IMAGE_MAGIC.to_le_bytes());
        data[4..8].copy_from_slice(&0x0802_0000u32.to_le_bytes());
        data[8..10].copy_from_slice(&(HEADER_SIZE as u16).to_le_bytes());
        data[10..12].copy_from_slice(&0u16.to_le_bytes());
        data[12..16].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        data[16..20].copy_from_slice(&0u32.to_le_bytes());
        data[20] = version.0;
        data[21] = version.1;
        data[22..24].copy_from_slice(&version.2.to_le_bytes());
        data[24..28].copy_from_slice(&version.3.to_le_bytes());
        data.extend_from_slice(&payload);

        let mut hashed = data.clone();
        if corrupt {
            hashed[HEADER_SIZE] ^= 0xFF;
        }
        let digest = Sha256::digest(&hashed);

        let tlv_total = 4 + 4 + digest.len() as u16;
        data.extend_from_slice(&IMAGE_TLV_INFO_MAGIC.to_le_bytes());
        data.extend_from_slice(&tlv_total.to_le_bytes());
        data.extend_from_slice(&IMAGE_TLV_SHA256.to_le_bytes());
        data.extend_from_slice(&(digest.len() as u16).to_le_bytes());
        data.extend_from_slice(&digest);
        data
    }

    const IMAGE_TLV_SHA256: u16 = 0x10;

    fn parse_bytes(bytes: &[u8]) -> ImageInfo {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "ota-host-image-test-{}-{}.bin",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, bytes).expect("写入测试镜像");
        let result = parse_image(path.to_string_lossy().as_ref()).expect("解析测试镜像");
        let _ = std::fs::remove_file(path);
        result
    }

    #[test]
    fn parses_valid_signed_image() {
        let info = parse_bytes(&build_image((1, 2, 3, 4), false));
        assert!(info.valid, "{}", info.message);
        assert_eq!(info.version.as_deref(), Some("1.2.3+4"));
        assert_eq!(info.image_size, 128);
        assert_eq!(info.hash_match, Some(true), "{}", info.message);
        assert_eq!(info.hash_algorithm.as_deref(), Some("SHA256"));
        assert!(info.tlvs.iter().any(|tlv| tlv.name == "SHA256"));
    }

    #[test]
    fn detects_hash_mismatch() {
        let info = parse_bytes(&build_image((1, 0, 0, 0), true));
        assert!(info.valid, "{}", info.message);
        assert_eq!(info.hash_match, Some(false));
        assert!(info.message.contains("不匹配"));
    }

    #[test]
    fn rejects_plain_bin() {
        let info = parse_bytes(&[0u8; 64]);
        assert!(!info.valid);
        assert!(info.message.contains("魔数"));
    }

    /// 仓库内真实的 imgtool 产物回归测试；文件不存在时跳过。
    #[test]
    fn parses_repo_signed_firmware_if_present() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../Keil_App/MDK-ARM/app_v1_signed.bin");
        if !path.exists() {
            return;
        }
        let info = parse_image(path.to_string_lossy().as_ref()).expect("解析仓库签名固件");
        assert!(info.valid, "{}", info.message);
        assert_eq!(info.version.as_deref(), Some("1.0.0+0"));
        assert_eq!(info.header_size, 0x200);
        assert_eq!(info.hash_match, Some(true), "{}", info.message);
        assert!(info.tlvs.iter().any(|tlv| tlv.name == "SHA256"));
        assert!(info.tlvs.iter().any(|tlv| tlv.name == "ECDSA-P256"));
        assert!(info.signature.as_deref().unwrap_or("").contains("ECDSA-P256"));
    }
}
