import { invoke } from "@tauri-apps/api/core";

// ===== 类型 =====
export interface SerialPortInfo {
  name: string;
  port_type: string;
  description: Option<string>;
  manufacturer: Option<string>;
  serial_number: Option<string>;
}
type Option<T> = T | null;

export interface SerialConfig {
  type: "local";
  port: string;
  baud_rate: number;
  data_bits?: number;
  stop_bits?: number;
  parity?: string;
  flow_control?: string;
  dtr?: boolean;
  rts?: boolean;
}

export interface SerialDataChunk {
  data: number[];
  timestamp: number;
}

export interface SerialDataEvent {
  chunks: SerialDataChunk[];
  direction: "rx";
}

export interface SerialStatusEvent {
  connected: boolean;
  running: boolean;
  error: Option<string>;
}

export interface SignOptions {
  input_path: string;
  output_path: string;
  version: string;
  key_path: string;
  header_size: number;
  slot_size: number;
  align: number;
  python: string;
  imgtool: string;
}

export interface SignResult {
  output_path: string;
  size: number;
}

// ===== MCUboot 镜像 / 槽位 =====
export interface ImageTlv {
  tlv_type: number;
  name: string;
  len: number;
  value: string;
}

export interface ImageInfo {
  path: string;
  file_size: number;
  magic: number;
  valid: boolean;
  version: Option<string>;
  load_addr: number;
  header_size: number;
  protect_tlv_size: number;
  image_size: number;
  flags: number;
  hash_algorithm: Option<string>;
  hash_tlv: Option<string>;
  computed_hash: Option<string>;
  hash_match: Option<boolean>;
  signature: Option<string>;
  keyhash: Option<string>;
  security_counter: Option<number>;
  tlvs: ImageTlv[];
  message: string;
}

export interface SlotQuery {
  name: string;
  address: number;
  size: number;
}

export interface SlotStatus {
  name: string;
  address: number;
  size: number;
  header_valid: boolean;
  version: Option<string>;
  image_size: Option<number>;
  header_size: Option<number>;
  trailer_valid: boolean;
  image_ok: Option<boolean>;
  copy_done: Option<boolean>;
  swap_info: Option<number>;
  swap_state: string;
  message: string;
}

// ===== 探针与烧录（probe-rs） =====
export interface ProbeInfo {
  probe_id: string;
  identifier: string;
  vendor_id: number;
  product_id: number;
  serial_number: Option<string>;
  probe_type: string;
  dap_version: Option<string>;
  debug_info: Option<string>;
  connection_hint: Option<string>;
}

export interface ConnectionInfo {
  probe_name: string;
  probe_serial: Option<string>;
  target_name: string;
  chip_id: Option<number>;
  target_idcode: Option<number>;
}

export interface ConnectionStatus {
  connected: boolean;
  info: Option<ConnectionInfo>;
}

export interface TargetInfo {
  name: string;
  chip_id: Option<number>;
  target_idcode: Option<number>;
}

export interface FlashProgressEvent {
  phase: string;
  progress: number;
  message: string;
}

// ===== 串口命令 =====
export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  return await invoke<SerialPortInfo[]>("list_serial_ports_cmd");
}

export async function connectSerial(config: SerialConfig): Promise<void> {
  return await invoke("connect_serial", { config });
}

export async function disconnectSerial(): Promise<void> {
  return await invoke("disconnect_serial");
}

export async function writeSerialString(text: string, lineEnding?: string): Promise<number> {
  return await invoke<number>("write_serial_string", { text, lineEnding: lineEnding ?? null });
}

export async function writeSerial(data: number[]): Promise<number> {
  return await invoke<number>("write_serial", { data });
}

export async function startSerial(): Promise<void> {
  return await invoke("start_serial");
}

export async function stopSerial(): Promise<void> {
  return await invoke("stop_serial");
}

// ===== OTA 签名命令 =====
export async function signFirmware(options: SignOptions): Promise<SignResult> {
  return await invoke<SignResult>("sign_firmware", { options });
}

// ===== 镜像校验 / 槽位状态 / 文本导出 =====
export async function inspectImage(path: string): Promise<ImageInfo> {
  return await invoke<ImageInfo>("inspect_image", { path });
}

export async function readSlotStatus(slots: SlotQuery[]): Promise<SlotStatus[]> {
  return await invoke<SlotStatus[]>("read_slot_status", { slots });
}

export async function saveTextFile(path: string, content: string): Promise<void> {
  return await invoke("save_text_file", { path, content });
}

// ===== 探针命令（probe-rs） =====
export async function listProbes(): Promise<ProbeInfo[]> {
  return await invoke<ProbeInfo[]>("list_probes");
}

export async function connectTarget(probeIdentifier: string, clockSpeedKhz?: number): Promise<TargetInfo> {
  return await invoke<TargetInfo>("connect_target", {
    options: { probe_identifier: probeIdentifier, clock_speed_khz: clockSpeedKhz ?? null },
  });
}

export async function disconnectProbe(): Promise<void> {
  return await invoke("disconnect");
}

export async function getConnectionStatus(): Promise<ConnectionStatus> {
  return await invoke<ConnectionStatus>("get_connection_status");
}

// ===== 烧录命令（probe-rs） =====
export interface FlashOptions {
  bin_path: string;
  address: number;
  verify?: boolean;
  reset_after?: boolean;
}

export async function flashFirmware(options: FlashOptions): Promise<void> {
  return await invoke("flash_firmware", { options });
}

// ===== RTT 命令 =====
export interface RttStartOptions {
  scan_mode?: "auto" | "exact";
  address?: number | null;
  poll_interval_ms?: number;
  auto_reattach?: boolean;
}

export interface RttChannelInfo {
  index: number;
  name: Option<string>;
  buffer_size: number;
}

export interface RttConfig {
  control_block_address: number;
  up_channels: RttChannelInfo[];
  down_channels: RttChannelInfo[];
}

export interface RttDataChunk {
  channel: number;
  /** base64 原始字节 */
  data: string;
  timestamp: number;
}

export interface RttDataEvent {
  chunks: RttDataChunk[];
}

export interface RttStatusEvent {
  running: boolean;
  attached: boolean;
  error: Option<string>;
  config: Option<RttConfig>;
}

export interface RttWriteOptions {
  channel?: number | null;
  text: string;
  hex?: boolean;
  line_ending?: string;
}

export async function startRtt(options: RttStartOptions): Promise<RttConfig> {
  return await invoke<RttConfig>("start_rtt", { options });
}

export async function stopRtt(): Promise<void> {
  return await invoke("stop_rtt");
}

export async function writeRtt(options: RttWriteOptions): Promise<number> {
  return await invoke<number>("write_rtt", { options });
}
