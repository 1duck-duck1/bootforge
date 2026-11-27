//! 串口 OTA 主机端（Keil_OTA_Boot/Core/Src/boot_ota.c 的对端）。
//!
//! 帧格式（USART2，115200 8N1）：
//!   0x7E | TYPE | SEQ | LEN(2, LE) | PAYLOAD | CRC16(2, LE) | 0x7E
//!   0x7E 转义为 0x7D 0x5E，0x7D 转义为 0x7D 0x5D；
//!   CRC16 = CCITT-FALSE（poly 0x1021，init 0xFFFF），覆盖 TYPE..PAYLOAD。
//!
//! 流程：OTA 握手（让 App 复位进入 Boot）-> QUERY（确认 Boot 在线并中止旧会话）
//!       -> START（按镜像大小擦除副槽扇区）-> DATA（每块 1020 字节，Stop-and-Wait）
//!       -> END（CRC32/SHA-256 校验）-> APPLY（boot_set_pending + 复位）
//!       -> 回连 QUERY 校验运行版本 -> EXIT（立即返回应用）。
//!
//! QUERY 在协议 v3 中返回 44 字节设备信息（协议/Boot 版本、UID、双槽版本、
//! 槽容量、交换状态、OTP 安全计数器），"读取设备状态"与升级后校验共用该查询。
//!
//! 串口接收/写 flash 全部在 Bootloader 内完成；App 只负责在收到 "OTA\n"
//! 后置备份寄存器标志并复位。App 无法启动时 Boot 会常驻 OTA 模式。
//!
//! 普通串口接收线程与 OTA 共用同一个 `SerialState::datasource`，命令入口会先
//! 停止接收线程；协议内部的读写每次只短暂持有锁，不阻塞其他状态查询。

use crate::state::SerialState;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const SOF: u8 = 0x7E;
const ESC: u8 = 0x7D;
const ESC_XOR: u8 = 0x20;

const FRAME_START: u8 = 0x01;
const FRAME_DATA: u8 = 0x02;
const FRAME_END: u8 = 0x03;
const FRAME_APPLY: u8 = 0x04;
const FRAME_ABORT: u8 = 0x05;
const FRAME_QUERY: u8 = 0x06;
const FRAME_EXIT: u8 = 0x07;

const FRAME_ACK: u8 = 0x81;
const FRAME_NACK: u8 = 0x82;
const FRAME_STATUS: u8 = 0x83;

const PROTOCOL_VERSION: u8 = 3;
const STATUS_LEN_V1: usize = 17;
const STATUS_LEN_V2: usize = 40;
const STATUS_LEN_V3: usize = 44;

const ERR_NONE: u8 = 0;
const ERR_OFFSET: u8 = 4;
const ERR_NO_SESSION: u8 = 6;
const ERR_BUSY: u8 = 7;

const STATE_IDLE: u8 = 0;
const STATE_RECEIVING: u8 = 1;
const STATE_READY: u8 = 2;

const OTA_MAX_DATA: usize = 1020;
const OTA_DATA_MIN: usize = 8;
const MAX_RX_PAYLOAD: usize = 1024;
const IMAGE_MAGIC: u32 = 0x96F3_B83D;
const IMAGE_HEADER_SIZE: usize = 32;

const QUERY_TIMEOUT: Duration = Duration::from_millis(1500);
const START_TIMEOUT: Duration = Duration::from_secs(30);
const ACK_TIMEOUT: Duration = Duration::from_millis(3000);
const END_TIMEOUT: Duration = Duration::from_secs(10);
const APPLY_TIMEOUT: Duration = Duration::from_secs(3);
const DATA_RETRIES: u32 = 5;
const MAX_RX_BUFFER: usize = 8192;

/// MCUboot swap + application startup + the app's confirmation window must
/// finish before the host asks the device to re-enter the bootloader for
/// version verification. The scratch swap erases three 128 KB sectors, which
/// can take several seconds, so this must stay well above the app's
/// APP_CONFIRM_SETTLE_MS (currently 5 s); otherwise the reconnect reset
/// interrupts the confirmation and MCUboot reverts the test image.
const POST_APPLY_WAIT: Duration = Duration::from_millis(15000);
const BOOT_HANDSHAKE_WAIT: Duration = Duration::from_millis(900);
const VERIFY_ATTEMPTS: u32 = 3;

const CANCELLED: &str = "已取消串口 OTA";

#[derive(Debug, Clone, Serialize)]
pub struct DeviceStatus {
    pub protocol_version: u8,
    pub state: u8,
    pub state_text: String,
    pub active_slot: String,
    pub swap_state: String,
    pub received: u32,
    pub total: u32,
    pub primary_version: Option<String>,
    pub secondary_version: Option<String>,
    pub slot_size: u32,
    pub uid: String,
    pub boot_version: String,
    /// 设备 OTP 安全计数器（协议 v3 起上报）；旧 Boot 为 None。
    pub security_counter: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SerialOtaResult {
    pub total_size: u32,
    pub crc32: u32,
    pub sha256: String,
    pub duration_ms: u64,
    pub applied: bool,
    pub device: Option<DeviceStatus>,
    /// 升级后回连读取到的主槽版本；None 表示未能回连确认。
    pub running_version: Option<String>,
    /// 回连读取的运行版本是否与本次写入的镜像版本一致。
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SerialOtaProgress {
    pub phase: String,
    pub progress: f64,
    pub sent: u64,
    pub total: u64,
    pub message: String,
    /// 前端是否需要把 message 追加到流程日志（进度类事件为 false，避免刷屏）
    pub log: bool,
}

#[derive(Debug)]
struct Frame {
    ftype: u8,
    seq: u8,
    payload: Vec<u8>,
}

#[derive(Debug)]
enum Reply {
    Ack { code: u8, next: u32 },
    Nack { reason: u8, expected: u32 },
    Status {
        protocol_version: u8,
        state: u8,
        active_slot: u8,
        swap_type: u8,
        received: u32,
        total: u32,
        primary: u32,
        secondary: u32,
        slot_size: u32,
        uid: String,
        boot_version: u32,
        security_counter: Option<u32>,
    },
}

struct Link<'a> {
    serial: &'a SerialState,
    rx: Vec<u8>,
    cancel: &'a AtomicBool,
}

impl<'a> Link<'a> {
    fn new(serial: &'a SerialState, cancel: &'a AtomicBool) -> Self {
        Self {
            serial,
            rx: Vec::new(),
            cancel,
        }
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }

    fn write_all(&mut self, data: &[u8]) -> Result<(), String> {
        let mut guard = self.serial.datasource.lock();
        let ds = guard
            .as_mut()
            .ok_or_else(|| "串口未连接，无法发送 OTA 数据".to_string())?;
        ds.write(data)?;
        Ok(())
    }

    fn read_into_buffer(&mut self) -> Result<usize, String> {
        let mut buf = [0u8; 2048];
        let n = {
            let mut guard = self.serial.datasource.lock();
            let ds = guard
                .as_mut()
                .ok_or_else(|| "串口已断开，OTA 中止".to_string())?;
            ds.read(&mut buf)?
        };
        if n > 0 {
            self.rx.extend_from_slice(&buf[..n]);
            if self.rx.len() > MAX_RX_BUFFER {
                // 长时间噪声：保留最后一帧可能存在的起点
                let drain = self.rx.len() - MAX_RX_BUFFER / 2;
                self.rx.drain(..drain);
            }
        }
        Ok(n)
    }

    /// 丢弃启动前的残留字节，避免把旧日志误当成应答。
    fn flush_input(&mut self) -> Result<(), String> {
        for _ in 0..16 {
            if self.read_into_buffer()? == 0 {
                break;
            }
        }
        self.rx.clear();
        Ok(())
    }

    fn recv_frame(&mut self, deadline: Instant) -> Result<Option<Frame>, String> {
        loop {
            if self.cancelled() {
                return Err(CANCELLED.to_string());
            }
            if let Some(frame) = extract_frame(&mut self.rx) {
                return Ok(Some(frame));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            self.read_into_buffer()?;
        }
    }
}

fn extract_frame(buf: &mut Vec<u8>) -> Option<Frame> {
    loop {
        let Some(start) = buf.iter().position(|&b| b == SOF) else {
            // 没有帧起始符的字节都是控制台文本/噪声
            buf.clear();
            return None;
        };
        if start > 0 {
            buf.drain(..start);
        }
        if buf.len() < 2 {
            return None;
        }
        let Some(end_rel) = buf[1..].iter().position(|&b| b == SOF) else {
            if buf.len() > MAX_RX_BUFFER {
                buf.clear();
            }
            return None;
        };
        let end = end_rel + 1;
        let body: Vec<u8> = buf[1..end].to_vec();
        buf.drain(..=end);

        let mut raw = Vec::with_capacity(body.len());
        let mut escaped = false;
        for byte in body {
            if escaped {
                raw.push(byte ^ ESC_XOR);
                escaped = false;
            } else if byte == ESC {
                escaped = true;
            } else {
                raw.push(byte);
            }
        }
        if escaped || raw.len() < 6 {
            continue;
        }

        let len = u16::from_le_bytes([raw[2], raw[3]]) as usize;
        if len > MAX_RX_PAYLOAD || len + 6 != raw.len() {
            continue;
        }
        let crc_rx = u16::from_le_bytes([raw[raw.len() - 2], raw[raw.len() - 1]]);
        if crc16_ccitt(&raw[..raw.len() - 2]) != crc_rx {
            continue;
        }

        return Some(Frame {
            ftype: raw[0],
            seq: raw[1],
            payload: raw[4..4 + len].to_vec(),
        });
    }
}

fn wait_reply(link: &mut Link, seq: u8, deadline: Instant) -> Result<Option<Reply>, String> {
    loop {
        let Some(frame) = link.recv_frame(deadline)? else {
            return Ok(None);
        };
        if frame.seq != seq {
            // 上一条命令的迟到应答，忽略
            continue;
        }
        match frame.ftype {
            FRAME_ACK if frame.payload.len() == 5 => {
                return Ok(Some(Reply::Ack {
                    code: frame.payload[0],
                    next: le_u32(&frame.payload, 1),
                }));
            }
            FRAME_NACK if frame.payload.len() == 5 => {
                return Ok(Some(Reply::Nack {
                    reason: frame.payload[0],
                    expected: le_u32(&frame.payload, 1),
                }));
            }
            FRAME_STATUS => {
                if let Some(reply) = parse_status(&frame.payload) {
                    return Ok(Some(reply));
                }
            }
            _ => {}
        }
    }
}

/// STATUS v1 (17 B, old firmware) / v2 (40 B) / v3 (44 B) 解析。
fn parse_status(payload: &[u8]) -> Option<Reply> {
    match payload.len() {
        STATUS_LEN_V3 => Some(Reply::Status {
            protocol_version: payload[0],
            state: payload[1],
            active_slot: payload[2],
            swap_type: payload[3],
            received: le_u32(payload, 4),
            total: le_u32(payload, 8),
            primary: le_u32(payload, 12),
            secondary: le_u32(payload, 16),
            slot_size: le_u32(payload, 20),
            uid: format!(
                "{:08X}{:08X}{:08X}",
                le_u32(payload, 24),
                le_u32(payload, 28),
                le_u32(payload, 32)
            ),
            boot_version: le_u32(payload, 36),
            security_counter: Some(le_u32(payload, 40)),
        }),
        STATUS_LEN_V2 => Some(Reply::Status {
            protocol_version: payload[0],
            state: payload[1],
            active_slot: payload[2],
            swap_type: payload[3],
            received: le_u32(payload, 4),
            total: le_u32(payload, 8),
            primary: le_u32(payload, 12),
            secondary: le_u32(payload, 16),
            slot_size: le_u32(payload, 20),
            uid: format!(
                "{:08X}{:08X}{:08X}",
                le_u32(payload, 24),
                le_u32(payload, 28),
                le_u32(payload, 32)
            ),
            boot_version: le_u32(payload, 36),
            security_counter: None,
        }),
        STATUS_LEN_V1 => Some(Reply::Status {
            protocol_version: 1,
            state: payload[0],
            active_slot: 0xFF,
            swap_type: 0,
            received: le_u32(payload, 1),
            total: le_u32(payload, 5),
            primary: le_u32(payload, 9),
            secondary: le_u32(payload, 13),
            slot_size: 0,
            uid: String::new(),
            boot_version: 0,
            security_counter: None,
        }),
        _ => None,
    }
}

fn send_and_wait(
    link: &mut Link,
    ftype: u8,
    seq: u8,
    payload: &[u8],
    timeout: Duration,
    retries: u32,
) -> Result<Reply, String> {
    let mut last_err = String::new();
    for attempt in 0..=retries {
        if link.cancelled() {
            return Err(CANCELLED.to_string());
        }
        let wire = encode_frame(ftype, seq, payload);
        // 重试前先补一个裸 SOF：若设备因上一帧被截断而停在"帧已打开"状态，
        // 这个 SOF 会先把残留帧收尾，随后重发的帧才能被识别。
        if attempt > 0 {
            link.write_all(&[SOF])?;
        }
        link.write_all(&wire)?;
        match wait_reply(link, seq, Instant::now() + timeout)? {
            Some(reply) => return Ok(reply),
            None => {
                last_err = format!("等待设备应答超时（{} ms）", timeout.as_millis());
                if attempt < retries {
                    // 给设备一点处理时间再重发
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
    Err(last_err)
}

fn transfer_chunk(
    link: &mut Link,
    seq: u8,
    payload: &[u8],
    cancel: &AtomicBool,
) -> Result<u32, String> {
    let mut last_err = String::new();
    for attempt in 0..=DATA_RETRIES {
        if cancel.load(Ordering::Acquire) {
            return Err(CANCELLED.to_string());
        }
        let wire = encode_frame(FRAME_DATA, seq, payload);
        // 与 send_and_wait 相同：重试时先发裸 SOF，清理设备端可能残留的半帧
        if attempt > 0 {
            link.write_all(&[SOF])?;
        }
        link.write_all(&wire)?;
        match wait_reply(link, seq, Instant::now() + ACK_TIMEOUT)? {
            Some(Reply::Ack { code: ERR_NONE, next }) => return Ok(next),
            Some(Reply::Ack { code, .. }) => return Err(format!("DATA 返回错误码 {code}")),
            // 偏移不匹配：设备告诉我们它期望的位置，按该位置重发
            Some(Reply::Nack { reason: ERR_OFFSET, expected }) => return Ok(expected),
            Some(Reply::Nack { reason, expected }) => {
                return Err(format!(
                    "DATA 被拒绝：{}（设备期望偏移 {}）",
                    reason_text(reason),
                    expected
                ));
            }
            Some(_) => last_err = "DATA 收到非预期应答".to_string(),
            None => {
                last_err = format!("DATA 应答超时（{} ms）", ACK_TIMEOUT.as_millis());
                if attempt < DATA_RETRIES {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
    Err(last_err)
}

fn query(link: &mut Link, seq: &mut u8) -> Result<DeviceStatus, String> {
    let frame_seq = alloc_seq(seq);
    match send_and_wait(link, FRAME_QUERY, frame_seq, &[], QUERY_TIMEOUT, 2)? {
        Reply::Status {
            protocol_version,
            state,
            active_slot,
            swap_type,
            received,
            total,
            primary,
            secondary,
            slot_size,
            uid,
            boot_version,
            security_counter,
        } => Ok(DeviceStatus {
            protocol_version,
            state,
            state_text: state_text(state).to_string(),
            active_slot: active_slot_text(active_slot).to_string(),
            swap_state: swap_state_text(swap_type).to_string(),
            received,
            total,
            primary_version: format_version(primary),
            secondary_version: format_version(secondary),
            slot_size,
            uid,
            boot_version: format_boot_version(boot_version),
            security_counter,
        }),
        Reply::Nack { reason, .. } => Err(format!("QUERY 被拒绝：{}", reason_text(reason))),
        _ => Err("QUERY 应答类型异常".to_string()),
    }
}

/// 设备端当前只上报 major/minor/revision 三个字节（0xMMmmRRRR）。
fn format_version(value: u32) -> Option<String> {
    if value == 0 {
        return None;
    }
    Some(format!(
        "{}.{}.{}",
        (value >> 24) & 0xFF,
        (value >> 16) & 0xFF,
        value & 0xFFFF
    ))
}

fn format_boot_version(value: u32) -> String {
    if value == 0 {
        return "未知".to_string();
    }
    format!(
        "{}.{}.{}",
        (value >> 24) & 0xFF,
        (value >> 16) & 0xFF,
        value & 0xFFFF
    )
}
/// 从 imgtool 签名镜像头读取 major.minor.revision，与设备端上报格式一致。
fn image_version(image: &[u8]) -> Option<String> {
    if image.len() < 24 {
        return None;
    }
    Some(format!(
        "{}.{}.{}",
        image[20],
        image[21],
        u16::from_le_bytes([image[22], image[23]])
    ))
}

/// 解析 `major.minor[.revision]`；缺省 revision 视为 0，格式不符返回 None。
fn parse_version(text: &str) -> Option<(u32, u32, u32)> {
    let mut parts = text.trim().split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next()?.parse::<u32>().ok()?;
    let revision = match parts.next() {
        Some(part) => part.parse::<u32>().ok()?,
        None => 0,
    };
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, revision))
}

/// 小端 u16 读取；越界返回 None。
fn le_u16(data: &[u8], offset: usize) -> Option<u16> {
    let end = offset.checked_add(2)?;
    let bytes = data.get(offset..end)?;
    Some(u16::from_le_bytes([bytes[0], bytes[1]]))
}

/// 计算镜像有效数据长度：镜像头 + 镜像体 + TLV 区。
/// `imgtool --pad` 产物在其后还有 0xFF 填充和槽尾 trailer；
/// 串口只传有效部分，trailer 由设备端 boot_set_pending() 写入。
fn image_payload_len(image: &[u8]) -> Option<usize> {
    const TLV_INFO_MAGIC: u16 = 0x6907;
    const TLV_PROT_INFO_MAGIC: u16 = 0x6908;

    if image.len() < IMAGE_HEADER_SIZE {
        return None;
    }

    let hdr_size = u16::from_le_bytes([image[8], image[9]]) as usize;
    let protect_tlv = u16::from_le_bytes([image[10], image[11]]) as usize;
    let img_size = u32::from_le_bytes([image[12], image[13], image[14], image[15]]) as usize;

    let mut tlv_start = hdr_size.checked_add(img_size)?;
    if protect_tlv != 0 {
        if le_u16(image, tlv_start)? != TLV_PROT_INFO_MAGIC {
            return None;
        }
        tlv_start = tlv_start.checked_add(protect_tlv)?;
    }

    if le_u16(image, tlv_start)? != TLV_INFO_MAGIC {
        return None;
    }
    let total = le_u16(image, tlv_start + 2)? as usize;
    if total < 4 {
        return None;
    }

    let end = tlv_start.checked_add(total)?;
    if end > image.len() {
        return None;
    }
    Some(end)
}

fn active_slot_text(slot: u8) -> &'static str {
    match slot {
        0 => "Primary 主槽",
        0xFF => "未知（主槽无有效镜像）",
        _ => "未知",
    }
}

/// boot_swap_type() 返回值（bootutil_public.h）。
fn swap_state_text(swap_type: u8) -> &'static str {
    match swap_type {
        1 => "none（无待处理交换）",
        2 => "test（测试升级待确认）",
        3 => "perm（永久升级）",
        4 => "revert（回滚中）",
        5 => "fail（交换失败）",
        0xFF => "panic（不可恢复错误）",
        _ => "unset（无交换记录）",
    }
}

fn state_text(state: u8) -> &'static str {
    match state {
        STATE_IDLE => "空闲",
        STATE_RECEIVING => "接收中",
        STATE_READY => "待升级",
        _ => "未知状态",
    }
}

fn reason_text(reason: u8) -> &'static str {
    match reason {
        1 => "参数或长度错误",
        2 => "副槽擦除失败",
        3 => "Flash 写入失败",
        4 => "偏移不匹配",
        5 => "CRC32/SHA-256 校验失败",
        6 => "设备上不存在 OTA 会话",
        7 => "设备忙",
        8 => "镜像超出副槽容量",
        9 => "安全计数器无效（低于设备值或超出 OTP 容量）",
        _ => "未知错误",
    }
}

fn hex(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len() * 2);
    for byte in data {
        out.push_str(&format!("{byte:02X}"));
    }
    out
}

fn le_u32(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ])
}

fn alloc_seq(seq: &mut u8) -> u8 {
    let value = *seq;
    *seq = (*seq).wrapping_add(1);
    value
}

fn crc16_ccitt(data: &[u8]) -> u16 {
    let mut crc = 0xFFFFu16;
    for &byte in data {
        crc ^= (byte as u16) << 8;
        for _ in 0..8 {
            if crc & 0x8000 != 0 {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc <<= 1;
            }
        }
    }
    crc
}

/// IEEE 802.3 CRC32（反射 poly 0xEDB88320，init/xorout 0xFFFFFFFF）
fn crc32_ieee(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    crc ^ 0xFFFF_FFFF
}

fn encode_frame(ftype: u8, seq: u8, payload: &[u8]) -> Vec<u8> {
    let mut raw = Vec::with_capacity(5 + payload.len() + 2);
    raw.push(ftype);
    raw.push(seq);
    raw.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    raw.extend_from_slice(payload);
    let crc = crc16_ccitt(&raw);
    raw.extend_from_slice(&crc.to_le_bytes());

    let mut wire = Vec::with_capacity(raw.len() * 2 + 2);
    wire.push(SOF);
    for byte in raw {
        if byte == SOF {
            wire.push(ESC);
            wire.push(SOF ^ ESC_XOR);
        } else if byte == ESC {
            wire.push(ESC);
            wire.push(ESC ^ ESC_XOR);
        } else {
            wire.push(byte);
        }
    }
    wire.push(SOF);
    wire
}

fn emit_progress(
    app: &AppHandle,
    phase: &str,
    progress: f64,
    sent: u64,
    total: u64,
    message: impl Into<String>,
    log: bool,
) {
    let _ = app.emit(
        "serial-ota-progress",
        SerialOtaProgress {
            phase: phase.to_string(),
            progress: progress.clamp(0.0, 1.0),
            sent,
            total,
            message: message.into(),
            log,
        },
    );
}

/// 出错时尽量让设备回到 IDLE，避免下次 START 收到 BUSY。
fn abort_session(link: &mut Link, seq: &mut u8) {
    let frame_seq = alloc_seq(seq);
    let _ = send_and_wait(
        link,
        FRAME_ABORT,
        frame_seq,
        &[],
        Duration::from_millis(800),
        1,
    );
}

fn fail_with_abort(link: &mut Link, seq: &mut u8, error: String) -> String {
    abort_session(link, seq);
    error
}

/// 让设备退出 Bootloader OTA 会话并立即启动应用（仅普通 OTA 窗口有效）。
fn send_exit(link: &mut Link, seq: &mut u8) {
    let frame_seq = alloc_seq(seq);
    let _ = send_and_wait(
        link,
        FRAME_EXIT,
        frame_seq,
        &[],
        Duration::from_millis(800),
        1,
    );
}

/// APPLY 后设备会复位并完成 swap。等待应用启动后发送 `OTA\n` 让其重新进入
/// Bootloader，用 QUERY 读取主槽版本，再发 EXIT 立即返回应用。
fn verify_running_version(
    app: &AppHandle,
    link: &mut Link,
    seq: &mut u8,
    expected: &str,
    total: u32,
) -> (Option<String>, bool) {
    emit_progress(
        app,
        "verify",
        1.0,
        total as u64,
        total as u64,
        "升级写入完成，等待设备重启并回连校验运行版本...",
        true,
    );

    std::thread::sleep(POST_APPLY_WAIT);

    let mut last_error = String::new();
    for attempt in 0..VERIFY_ATTEMPTS {
        let _ = link.flush_input();
        if let Err(error) = link.write_all(b"OTA\n") {
            last_error = format!("发送进入 Bootloader 命令失败: {error}");
        } else {
            std::thread::sleep(BOOT_HANDSHAKE_WAIT);
            match query(link, seq) {
                Ok(status) => {
                    // 查询完成后立即退出 Boot，避免设备停留在 OTA 模式等待超时。
                    send_exit(link, seq);
                    let running = status.primary_version;
                    let verified = running.as_deref() == Some(expected);
                    emit_progress(
                        app,
                        "verify",
                        1.0,
                        total as u64,
                        total as u64,
                        if verified {
                            format!("升级后运行版本 v{expected}，校验一致")
                        } else {
                            format!(
                                "升级后运行版本 {}，与目标 v{expected} 不一致",
                                running.as_deref().unwrap_or("未知")
                            )
                        },
                        true,
                    );
                    return (running, verified);
                }
                Err(error) => last_error = error,
            }
        }
        if attempt + 1 < VERIFY_ATTEMPTS {
            // 交换/启动可能还没结束，稍后再试一次握手。
            std::thread::sleep(Duration::from_millis(1500));
        }
    }

    // 查询失败也尝试发一次 EXIT，设备若已在 Boot 中可尽快回到应用。
    send_exit(link, seq);
    emit_progress(
        app,
        "verify",
        1.0,
        total as u64,
        total as u64,
        format!("升级后未能确认运行版本：{last_error}"),
        true,
    );
    (None, false)
}

/// 读取设备信息：让应用重启进入 Bootloader 查询，随后发 EXIT 立即回到应用。
/// 不会擦写 Flash。
pub fn read_device_info(
    serial: &SerialState,
    cancel: &AtomicBool,
) -> Result<DeviceStatus, String> {
    let mut link = Link::new(serial, cancel);
    link.flush_input()
        .map_err(|e| format!("串口不可用: {e}"))?;

    let mut seq = 1u8;
    link.write_all(b"OTA\n")
        .map_err(|e| format!("发送进入 Bootloader 命令失败: {e}"))?;
    std::thread::sleep(BOOT_HANDSHAKE_WAIT);

    let result = query(&mut link, &mut seq);
    send_exit(&mut link, &mut seq);
    result
}

/// 当前串口名（如 `COM6@115200`），用于把"查询无应答"定位到具体端口。
fn port_name(serial: &SerialState) -> String {
    serial
        .datasource
        .lock()
        .as_ref()
        .map(|ds| ds.name())
        .unwrap_or_else(|| "未知串口".to_string())
}

pub fn run(
    app: &AppHandle,
    serial: &SerialState,
    image_path: &str,
    deny_downgrade: bool,
    cancel: &AtomicBool,
) -> Result<SerialOtaResult, String> {
    let started = Instant::now();

    let image = std::fs::read(image_path).map_err(|e| format!("读取固件失败: {e}"))?;
    if image.len() <= IMAGE_HEADER_SIZE {
        return Err(format!(
            "固件只有 {} 字节，不是有效的 MCUboot 签名镜像",
            image.len()
        ));
    }
    if image.len() > u32::MAX as usize {
        return Err("固件超过 4 GB，协议无法表示".to_string());
    }
    let magic = u32::from_le_bytes([image[0], image[1], image[2], image[3]]);
    if magic != IMAGE_MAGIC {
        return Err(format!(
            "固件头部 magic 为 0x{magic:08X}，不是 MCUboot 签名镜像（应为 0x{IMAGE_MAGIC:08X}），请先完成签名"
        ));
    }

    // `imgtool --pad` 产物 = [有效镜像][0xFF 填充][槽尾 trailer]。
    // 串口只发送有效镜像部分；trailer 由 Bootloader 在 APPLY 时写入。
    let payload_len = image_payload_len(&image).unwrap_or(image.len());
    let image = &image[..payload_len];

    let expected_version = image_version(image).unwrap_or_default();
    let total = image.len() as u32;
    let crc = crc32_ieee(image);
    let digest: [u8; 32] = Sha256::digest(image).into();

    let mut link = Link::new(serial, cancel);
    link.flush_input()
        .map_err(|e| format!("串口不可用: {e}"))?;
    let mut seq = 1u8;

    // 握手：让正在运行的 App 复位进入 Bootloader 串口 OTA 模式。
    // 设备已经在 Boot 里时这段文本会被忽略，不影响后续 QUERY。
    emit_progress(
        app,
        "enter",
        0.0,
        0,
        total as u64,
        "请求设备进入 Bootloader 串口 OTA...",
        true,
    );
    link.write_all(b"OTA\n")
        .map_err(|e| format!("发送进入 Bootloader 命令失败: {e}"))?;
    std::thread::sleep(Duration::from_millis(300));

    emit_progress(app, "query", 0.0, 0, total as u64, "查询设备状态...", true);
    let status = match query(&mut link, &mut seq) {
        Ok(status) => status,
        Err(e) if e == CANCELLED => return Err(CANCELLED.to_string()),
        Err(e) => {
            return Err(format!(
                "{e}（{}）；请依次确认：该端口接到设备 USART2（PD5/PD6）且波特率 115200 8N1；\
                 App 正常时会在收到 OTA 握手命令后自动复位进入 Boot；\
                 串口日志应出现 Boot 的 \"Serial OTA mode\"；若 App 已损坏，Boot 会常驻串口 OTA",
                port_name(serial)
            ));
        }
    };
    emit_progress(
        app,
        "query",
        0.0,
        0,
        total as u64,
        format!(
            "设备{}：主槽 {}，副槽 {}",
            state_text(status.state),
            status.primary_version.as_deref().unwrap_or("未知"),
            status.secondary_version.as_deref().unwrap_or("空")
        ),
        true,
    );

    if deny_downgrade {
        if let (Some(img_v), Some(dev_text)) =
            (parse_version(&expected_version), status.primary_version.as_deref())
        {
            if let Some(dev_v) = parse_version(dev_text) {
                if img_v < dev_v {
                    send_exit(&mut link, &mut seq);
                    return Err(format!(
                        "版本降级已阻止：镜像 v{expected_version} 低于设备主槽 v{dev_text}；\
                         如确需降级，请关闭“禁止版本降级”"
                    ));
                }
            }
        }
    }

    if status.state != STATE_IDLE {
        emit_progress(
            app,
            "query",
            0.0,
            0,
            total as u64,
            "检测到未完成的 OTA 会话，先发送 ABORT",
            true,
        );
        let frame_seq = alloc_seq(&mut seq);
        match send_and_wait(
            &mut link,
            FRAME_ABORT,
            frame_seq,
            &[],
            Duration::from_millis(1500),
            2,
        ) {
            Ok(Reply::Ack { code: ERR_NONE, .. }) => {}
            Ok(Reply::Nack { reason, .. }) => {
                return Err(format!("中止旧会话失败：{}", reason_text(reason)));
            }
            Ok(_) => return Err("中止旧会话时收到非预期应答".to_string()),
            Err(e) => return Err(format!("中止旧会话失败：{e}")),
        }
    }

    // START：镜像总长 + 整镜像 CRC32，设备擦除副槽后返回 ACK(0, 0)
    emit_progress(
        app,
        "start",
        0.0,
        0,
        total as u64,
        "发送 START，设备正在擦除 Secondary 副槽所需扇区（可能需要数秒）...",
        true,
    );
    let mut start_payload = Vec::with_capacity(8);
    start_payload.extend_from_slice(&total.to_le_bytes());
    start_payload.extend_from_slice(&crc.to_le_bytes());
    let start_seq = alloc_seq(&mut seq);
    let mut start_error = String::new();
    let mut started_ok = false;
    for attempt in 0..3 {
        if cancel.load(Ordering::Acquire) {
            abort_session(&mut link, &mut seq);
            return Err(CANCELLED.to_string());
        }
        match send_and_wait(
            &mut link,
            FRAME_START,
            start_seq,
            &start_payload,
            START_TIMEOUT,
            0,
        ) {
            Ok(Reply::Ack { code: ERR_NONE, .. }) => {
                started_ok = true;
                break;
            }
            // 此前已确认设备 IDLE，BUSY 只可能是自己上一帧 START 的 ACK 丢失。
            Ok(Reply::Nack { reason: ERR_BUSY, .. }) => {
                started_ok = true;
                break;
            }
            Ok(Reply::Nack { reason, .. }) => {
                return Err(format!("START 被拒绝：{}", reason_text(reason)));
            }
            Ok(Reply::Ack { code, .. }) => return Err(format!("START 返回错误码 {code}")),
            Ok(_) => start_error = "START 收到非预期应答".to_string(),
            Err(e) => start_error = e,
        }
        if attempt < 2 {
            emit_progress(
                app,
                "start",
                0.0,
                0,
                total as u64,
                format!("START 未确认（{start_error}），重试..."),
                true,
            );
        }
    }
    if !started_ok {
        return Err(fail_with_abort(
            &mut link,
            &mut seq,
            format!("START 失败：{start_error}"),
        ));
    }

    // DATA：每块最多 1020 字节（设备帧 payload 上限 1024，含 4 字节 offset）
    // Stop-and-Wait；最后一块至少 8 字节
    let mut offset = 0usize;
    let mut last_log_percent = 0u32;
    while offset < image.len() {
        if cancel.load(Ordering::Acquire) {
            abort_session(&mut link, &mut seq);
            return Err(CANCELLED.to_string());
        }

        let remaining = image.len() - offset;
        let mut chunk = remaining.min(OTA_MAX_DATA);
        if remaining > chunk && remaining - chunk < OTA_DATA_MIN {
            // 避免最后一块小于设备要求的最小 DATA 长度
            chunk -= OTA_DATA_MIN - (remaining - chunk);
        }

        let mut payload = Vec::with_capacity(4 + chunk);
        payload.extend_from_slice(&(offset as u32).to_le_bytes());
        payload.extend_from_slice(&image[offset..offset + chunk]);

        let frame_seq = alloc_seq(&mut seq);
        let next = match transfer_chunk(&mut link, frame_seq, &payload, cancel) {
            Ok(next) => next,
            Err(e) if e == CANCELLED => {
                abort_session(&mut link, &mut seq);
                return Err(CANCELLED.to_string());
            }
            Err(e) => return Err(fail_with_abort(&mut link, &mut seq, e)),
        };

        let next = next as usize;
        if next > image.len() {
            return Err(fail_with_abort(
                &mut link,
                &mut seq,
                format!("设备返回的偏移 {next} 超出镜像大小 {}", image.len()),
            ));
        }
        if next <= offset {
            return Err(fail_with_abort(
                &mut link,
                &mut seq,
                format!("设备未推进写入偏移（{offset} -> {next}）"),
            ));
        }
        offset = next;

        let progress = offset as f64 / total as f64;
        let percent = (progress * 100.0).floor() as u32;
        let log = percent >= last_log_percent + 20 || offset == image.len();
        if log {
            last_log_percent = percent;
        }
        emit_progress(
            app,
            "data",
            progress,
            offset as u64,
            total as u64,
            format!("已写入 {offset}/{} 字节（{percent}%）", image.len()),
            log,
        );
    }

    // END：总长 + CRC32 + SHA-256，设备做最终校验
    emit_progress(
        app,
        "end",
        1.0,
        total as u64,
        total as u64,
        "数据发送完成，设备正在校验 CRC32 / SHA-256...",
        true,
    );
    let mut end_payload = Vec::with_capacity(40);
    end_payload.extend_from_slice(&total.to_le_bytes());
    end_payload.extend_from_slice(&crc.to_le_bytes());
    end_payload.extend_from_slice(&digest);
    let end_seq = alloc_seq(&mut seq);
    match send_and_wait(
        &mut link,
        FRAME_END,
        end_seq,
        &end_payload,
        END_TIMEOUT,
        2,
    ) {
        Ok(Reply::Ack { code: ERR_NONE, .. }) => {}
        // END 的 ACK 丢失后重发会得到 NO_SESSION：用 QUERY 确认已进入 READY
        Ok(Reply::Nack { reason: ERR_NO_SESSION, .. }) => {
            let status = query(&mut link, &mut seq)
                .map_err(|e| fail_with_abort(&mut link, &mut seq, e))?;
            if status.state != STATE_READY {
                return Err(fail_with_abort(
                    &mut link,
                    &mut seq,
                    "END 未确认，且设备未进入待升级状态".to_string(),
                ));
            }
        }
        Ok(Reply::Nack { reason, .. }) => {
            return Err(format!("END 校验失败：{}", reason_text(reason)));
        }
        Ok(_) => {
            return Err(fail_with_abort(
                &mut link,
                &mut seq,
                "END 收到非预期应答".to_string(),
            ));
        }
        Err(e) => return Err(fail_with_abort(&mut link, &mut seq, e)),
    }

    // APPLY：设备标记 pending 后复位。ACK 可能来不及发出，超时按"已触发重启"处理。
    emit_progress(
        app,
        "apply",
        1.0,
        total as u64,
        total as u64,
        "发送 APPLY，设备将标记升级并重启...",
        true,
    );
    let apply_seq = alloc_seq(&mut seq);
    let wire = encode_frame(FRAME_APPLY, apply_seq, &[]);
    link.write_all(&wire)?;
    let applied = match wait_reply(&mut link, apply_seq, Instant::now() + APPLY_TIMEOUT) {
        Ok(Some(Reply::Ack { code: ERR_NONE, .. })) => true,
        Ok(Some(Reply::Nack { reason, .. })) => {
            return Err(format!("APPLY 被拒绝：{}", reason_text(reason)));
        }
        Ok(Some(_)) => return Err("APPLY 收到非预期应答".to_string()),
        Ok(None) => {
            emit_progress(
                app,
                "apply",
                1.0,
                total as u64,
                total as u64,
                "未收到 APPLY 应答，设备可能已开始重启",
                true,
            );
            true
        }
        Err(_) if cancel.load(Ordering::Acquire) => {
            // APPLY 已经发出，此时取消也无法阻止重启
            true
        }
        Err(e) => return Err(e),
    };

    // 回连校验：等待设备完成 swap 并启动应用，再进入 Boot 读取主槽版本。
    let (running_version, verified) = if applied && !expected_version.is_empty() {
        verify_running_version(app, &mut link, &mut seq, &expected_version, total)
    } else {
        (None, false)
    };

    let elapsed_ms = started.elapsed().as_millis() as u64;
    let verify_text = match (&running_version, verified) {
        (Some(version), true) => format!("，运行版本 v{version} 校验一致"),
        (Some(version), false) => format!("，运行版本 v{version} 与目标版本不一致"),
        (None, _) => "，未能回连确认运行版本".to_string(),
    };
    emit_progress(
        app,
        "complete",
        1.0,
        total as u64,
        total as u64,
        format!(
            "串口 OTA 完成：{} 字节，CRC32 {crc:08X}，耗时 {:.1} s{verify_text}",
            total,
            elapsed_ms as f64 / 1000.0
        ),
        true,
    );

    Ok(SerialOtaResult {
        total_size: total,
        crc32: crc,
        sha256: hex(&digest),
        duration_ms: elapsed_ms,
        applied,
        device: Some(status),
        running_version,
        verified,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc16_ccitt_known_vector() {
        assert_eq!(crc16_ccitt(b"123456789"), 0x29B1);
    }

    #[test]
    fn crc32_ieee_known_vector() {
        assert_eq!(crc32_ieee(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn frame_roundtrip_escapes_special_bytes() {
        let payload = vec![SOF, ESC, 0x00, 0x7E, 0x7D, 0x20];
        let mut wire = encode_frame(FRAME_DATA, 7, &payload);
        let frame = extract_frame(&mut wire).expect("frame decoded");
        assert_eq!(frame.ftype, FRAME_DATA);
        assert_eq!(frame.seq, 7);
        assert_eq!(frame.payload, payload);
        assert!(wire.is_empty());
    }

    #[test]
    fn frame_roundtrip_ignores_leading_noise() {
        let payload = vec![1, 2, 3];
        let mut wire = vec![0x41, 0x42];
        wire.extend_from_slice(&encode_frame(FRAME_QUERY, 9, &payload));
        let frame = extract_frame(&mut wire).expect("frame decoded");
        assert_eq!(frame.ftype, FRAME_QUERY);
        assert_eq!(frame.seq, 9);
        assert_eq!(frame.payload, payload);
    }

    #[test]
    fn frame_with_bad_crc_is_rejected() {
        let mut wire = encode_frame(FRAME_QUERY, 9, &[1, 2, 3]);
        wire[1] ^= 0x01;
        assert!(extract_frame(&mut wire).is_none());
    }

    #[test]
    fn status_v2_payload_is_parsed() {
        let mut payload = vec![0u8; STATUS_LEN_V2];
        payload[0] = PROTOCOL_VERSION;
        payload[1] = STATE_READY;
        payload[2] = 0;
        payload[3] = 1;
        payload[4..8].copy_from_slice(&123u32.to_le_bytes());
        payload[8..12].copy_from_slice(&456u32.to_le_bytes());
        payload[12..16].copy_from_slice(&0x0102_0003u32.to_le_bytes());
        payload[16..20].copy_from_slice(&0x0203_0004u32.to_le_bytes());
        payload[20..24].copy_from_slice(&0x0006_0000u32.to_le_bytes());
        payload[24..28].copy_from_slice(&0xAABB_CCDDu32.to_le_bytes());
        payload[28..32].copy_from_slice(&0x1122_3344u32.to_le_bytes());
        payload[32..36].copy_from_slice(&0x5566_7788u32.to_le_bytes());
        payload[36..40].copy_from_slice(&0x0100_0000u32.to_le_bytes());

        match parse_status(&payload).expect("v2 status") {
            Reply::Status {
                protocol_version,
                state,
                active_slot,
                swap_type,
                received,
                total,
                primary,
                secondary,
                slot_size,
                uid,
                boot_version,
                security_counter,
            } => {
                assert_eq!(protocol_version, PROTOCOL_VERSION);
                assert_eq!(state, STATE_READY);
                assert_eq!(active_slot, 0);
                assert_eq!(swap_type, 1);
                assert_eq!(received, 123);
                assert_eq!(total, 456);
                assert_eq!(primary, 0x0102_0003);
                assert_eq!(secondary, 0x0203_0004);
                assert_eq!(slot_size, 0x0006_0000);
                assert_eq!(uid, "AABBCCDD1122334455667788");
                assert_eq!(boot_version, 0x0100_0000);
                assert_eq!(security_counter, None);
            }
            other => panic!("unexpected reply: {other:?}"),
        }
    }

    #[test]
    fn status_v3_payload_reports_security_counter() {
        let mut payload = vec![0u8; STATUS_LEN_V3];
        payload[0] = PROTOCOL_VERSION;
        payload[40..44].copy_from_slice(&7u32.to_le_bytes());

        match parse_status(&payload).expect("v3 status") {
            Reply::Status {
                security_counter, ..
            } => assert_eq!(security_counter, Some(7)),
            other => panic!("unexpected reply: {other:?}"),
        }
    }

    #[test]
    fn version_helpers_format_like_device() {
        assert_eq!(format_version(0x0102_0003).as_deref(), Some("1.2.3"));
        assert_eq!(format_version(0), None);
        assert_eq!(format_boot_version(0x0100_0000), "1.0.0");
        assert_eq!(format_boot_version(0), "未知");
    }

    #[test]
    fn image_version_reads_header() {
        let mut image = vec![0u8; IMAGE_HEADER_SIZE + 8];
        image[20] = 1;
        image[21] = 2;
        image[22..24].copy_from_slice(&3u16.to_le_bytes());
        assert_eq!(image_version(&image).as_deref(), Some("1.2.3"));
    }

    #[test]
    fn parses_and_orders_versions() {
        assert_eq!(parse_version("1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("1.2"), Some((1, 2, 0)));
        assert!(parse_version("1.0.9") < parse_version("1.0.10"));
        assert!(parse_version("2.0.0") > parse_version("1.99.99"));
        assert_eq!(parse_version("1.x"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
    }

    #[test]
    fn payload_len_stops_at_tlv_end() {
        let mut image = vec![0u8; IMAGE_HEADER_SIZE];
        image[8..10].copy_from_slice(&(IMAGE_HEADER_SIZE as u16).to_le_bytes());
        image[10..12].copy_from_slice(&0u16.to_le_bytes());
        image[12..16].copy_from_slice(&8u32.to_le_bytes());
        image.extend_from_slice(&[0xAA; 8]);

        // TLV 区：info header(magic + total=8) + 一个空 TLV(4B)
        let tlv_start = IMAGE_HEADER_SIZE + 8;
        image.extend_from_slice(&0x6907u16.to_le_bytes());
        image.extend_from_slice(&8u16.to_le_bytes());
        image.extend_from_slice(&0x0010u16.to_le_bytes());
        image.extend_from_slice(&0u16.to_le_bytes());

        // 模拟 imgtool --pad 的 0xFF 填充
        image.extend_from_slice(&[0xFF; 32]);

        assert_eq!(image_payload_len(&image), Some(tlv_start + 8));
    }
}
