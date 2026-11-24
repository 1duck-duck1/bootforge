import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  startRtt,
  stopRtt,
  writeRtt,
  type RttConfig,
  type RttStatusEvent,
} from "@/lib/tauri";
import { parseHexBytes, parseHexNumber } from "@/lib/hex";
import { useLogStore } from "./logStore";
import { normalizeDataViewMode, type DataViewMode } from "@/lib/dataView";

export type RttLineEnding = "none" | "lf" | "crlf" | "cr";

export interface RttLine {
  id: number;
  channel: number;
  text: string;
  /** 原始字节，HEX 显示与导出使用 */
  bytes: number[];
  timestamp: number;
  direction: "rx" | "tx";
}

const MAX_LINES = 5000;
/** 全部通道的哨兵值 */
export const RTT_ALL_CHANNELS = -1;

const LINE_ENDING_SUFFIX: Record<RttLineEnding, string> = {
  none: "",
  lf: "\n",
  crlf: "\r\n",
  cr: "\r",
};

let nextLineId = Date.now() * 1000;

export function nextRttLineId(): number {
  nextLineId += 1;
  return nextLineId;
}

interface RttStore {
  running: boolean;
  attached: boolean;
  starting: boolean;
  error: string | null;
  config: RttConfig | null;
  lines: RttLine[];
  bytesReceived: number;
  bytesSent: number;

  // 显示选项
  selectedChannel: number;
  showTimestamp: boolean;
  hexView: boolean;
  autoScroll: boolean;
  paused: boolean;
  search: string;
  viewMode: DataViewMode;

  // 启动配置
  scanMode: "auto" | "exact";
  address: string;
  pollInterval: number;
  autoReattach: boolean;

  start: () => Promise<void>;
  stop: () => Promise<void>;
  send: (
    text: string,
    lineEnding: RttLineEnding,
    hexMode: boolean,
    channelOverride?: number
  ) => Promise<void>;
  addLines: (lines: RttLine[]) => void;
  applyStatus: (status: RttStatusEvent) => void;
  clear: () => void;
  setSelectedChannel: (channel: number) => void;
  setShowTimestamp: (value: boolean) => void;
  setHexView: (value: boolean) => void;
  setAutoScroll: (value: boolean) => void;
  setPaused: (value: boolean) => void;
  setSearch: (value: string) => void;
  setViewMode: (mode: DataViewMode) => void;
  setStartOptions: (options: {
    scanMode?: "auto" | "exact";
    address?: string;
    pollInterval?: number;
    autoReattach?: boolean;
  }) => void;
}

export const useRttStore = create<RttStore>()(
  persist(
    (set, get) => ({
      running: false,
      attached: false,
      starting: false,
      error: null,
      config: null,
      lines: [],
      bytesReceived: 0,
      bytesSent: 0,

      selectedChannel: RTT_ALL_CHANNELS,
      showTimestamp: true,
      hexView: false,
      autoScroll: true,
      paused: false,
      search: "",
      viewMode: "text",

      scanMode: "auto",
      address: "",
      pollInterval: 10,
      autoReattach: true,

      start: async () => {
        const addLog = useLogStore.getState().addLog;
        const { scanMode, address, pollInterval, autoReattach } = get();

        let controlBlock: number | null = null;
        if (scanMode === "exact") {
          controlBlock = parseHexNumber(address);
          if (controlBlock === null) {
            addLog("warn", "请填写有效的 RTT 控制块地址，例如 0x20000000");
            return;
          }
        }

        set({ starting: true, error: null });
        try {
          const config = await startRtt({
            scan_mode: scanMode,
            address: controlBlock,
            poll_interval_ms: pollInterval,
            auto_reattach: autoReattach,
          });
          set((state) => ({
            starting: false,
            running: true,
            attached: true,
            config,
            error: null,
            selectedChannel:
              state.selectedChannel === RTT_ALL_CHANNELS ||
              config.up_channels.some((channel) => channel.index === state.selectedChannel)
                ? state.selectedChannel
                : RTT_ALL_CHANNELS,
          }));
          addLog(
            "success",
            `RTT 已附着 @ 0x${config.control_block_address.toString(16).toUpperCase()}，` +
              `上行 ${config.up_channels.length} 个通道 / 下行 ${config.down_channels.length} 个通道`
          );
        } catch (error) {
          set({ starting: false, running: false, attached: false, error: String(error) });
          addLog("error", `RTT 启动失败: ${error}`);
        }
      },

      stop: async () => {
        try {
          await stopRtt();
          set({ running: false, attached: false, error: null });
          useLogStore.getState().addLog("info", "RTT 已停止");
        } catch (error) {
          useLogStore.getState().addLog("error", `停止 RTT 失败: ${error}`);
        }
      },

      send: async (text, lineEnding, hexMode, channelOverride) => {
        if (!text) return;
        const { selectedChannel, config } = get();

        let bytes: number[] | null;
        if (hexMode) {
          bytes = parseHexBytes(text);
          if (bytes === null) {
            useLogStore.getState().addLog("warn", "RTT HEX 发送格式错误：需要偶数个十六进制字符");
            return;
          }
        } else {
          bytes = Array.from(new TextEncoder().encode(text + LINE_ENDING_SUFFIX[lineEnding]));
        }
        if (bytes.length === 0) return;

        const channel =
          channelOverride ??
          (selectedChannel === RTT_ALL_CHANNELS
            ? (config?.down_channels[0]?.index ?? 0)
            : selectedChannel);

        try {
          await writeRtt({
            channel,
            text,
            hex: hexMode,
            line_ending: hexMode ? undefined : lineEnding,
          });
          set((state) => ({
            bytesSent: state.bytesSent + bytes.length,
            lines: [
              ...state.lines.slice(-MAX_LINES + 1),
              {
                id: nextRttLineId(),
                channel,
                text: hexMode ? `HEX: ${bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ")}` : text,
                bytes,
                timestamp: Date.now(),
                direction: "tx" as const,
              },
            ],
          }));
        } catch (error) {
          useLogStore.getState().addLog("error", `RTT 发送失败: ${error}`);
        }
      },

      addLines: (newLines) =>
        set((state) => {
          const received = newLines
            .filter((line) => line.direction === "rx")
            .reduce((sum, line) => sum + line.bytes.length, 0);
          return {
            lines: [...state.lines, ...newLines].slice(-MAX_LINES),
            bytesReceived: state.bytesReceived + received,
          };
        }),

      applyStatus: (status) =>
        set((state) => ({
          running: status.running,
          attached: status.attached,
          starting: status.running ? false : state.starting,
          error: status.error ?? (status.running ? null : state.error),
          config: status.config ?? state.config,
        })),

      clear: () => set({ lines: [], bytesReceived: 0, bytesSent: 0 }),
      setSelectedChannel: (selectedChannel) => set({ selectedChannel }),
      setShowTimestamp: (showTimestamp) => set({ showTimestamp }),
      setHexView: (hexView) => set({ hexView }),
      setAutoScroll: (autoScroll) => set({ autoScroll }),
      setPaused: (paused) => set({ paused }),
      setSearch: (search) => set({ search }),
      setViewMode: (viewMode) => set({ viewMode }),
      setStartOptions: (options) =>
        set((state) => ({
          scanMode: options.scanMode ?? state.scanMode,
          address: options.address ?? state.address,
          pollInterval: options.pollInterval ?? state.pollInterval,
          autoReattach: options.autoReattach ?? state.autoReattach,
        })),
    }),
    {
      name: "ota-host-rtt",
      // 兼容旧版本持久化数据：viewMode 的 "terminal" 迁移为 "text"
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<RttStore> & { viewMode?: unknown };
        return {
          ...current,
          ...saved,
          viewMode: normalizeDataViewMode(saved.viewMode) ?? current.viewMode,
        };
      },
      partialize: (state) => ({
        scanMode: state.scanMode,
        address: state.address,
        pollInterval: state.pollInterval,
        autoReattach: state.autoReattach,
        showTimestamp: state.showTimestamp,
        hexView: state.hexView,
        autoScroll: state.autoScroll,
        viewMode: state.viewMode,
      }),
    }
  )
);
