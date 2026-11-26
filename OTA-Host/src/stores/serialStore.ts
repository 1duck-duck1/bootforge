import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  connectSerial,
  disconnectSerial,
  listSerialPorts,
  startSerial,
  stopSerial,
  writeSerial,
  writeSerialString,
  type SerialPortInfo,
} from "@/lib/tauri";
import { useLogStore } from "./logStore";
import { normalizeDataViewMode, type DataViewMode } from "@/lib/dataView";

export type LineEnding = "none" | "lf" | "crlf" | "cr";

export interface SerialLine {
  id: number;
  text: string;
  /** 原始字节，HEX 显示与日志导出使用 */
  bytes: number[];
  timestamp: number;
  direction: "rx" | "tx";
}

const MAX_LINES = 5000;
// RX/TX 共用单调递增的行 ID，一键升级用它判断"之后的新日志"
let nextLineId = Date.now() * 1000;

export function nextSerialLineId(): number {
  nextLineId += 1;
  return nextLineId;
}

const LINE_ENDING_BYTES: Record<LineEnding, string> = {
  none: "",
  lf: "\n",
  crlf: "\r\n",
  cr: "\r",
};

export interface SerialForm {
  port: string;
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: "none" | "odd" | "even";
  flowControl: "none" | "software" | "hardware";
  dtr: boolean;
  rts: boolean;
  lineEnding: LineEnding;
  showTimestamp: boolean;
  hexView: boolean;
}

interface SerialStore {
  ports: SerialPortInfo[];
  form: SerialForm;
  connected: boolean;
  running: boolean;
  /** 串口 OTA 独占串口期间为 true（接收线程被暂停） */
  otaBusy: boolean;
  error: string | null;
  lines: SerialLine[];
  autoScroll: boolean;
  /** 暂停刷新：新日志仍会接收，恢复后一次性追加 */
  paused: boolean;
  /** 收发分屏：RX/TX 分两列显示 */
  splitView: boolean;
  /** 工作区视图：文本 / 分屏 / 图表 */
  viewMode: DataViewMode;
  bytesReceived: number;
  bytesSent: number;
  // actions
  setForm: (form: Partial<SerialForm>) => void;
  refreshPorts: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  startReceiving: () => Promise<void>;
  stopReceiving: () => Promise<void>;
  send: (text: string, lineEnding?: LineEnding) => Promise<void>;
  sendBytes: (bytes: number[]) => Promise<void>;
  addLines: (lines: SerialLine[]) => void;
  clear: () => void;
  setAutoScroll: (value: boolean) => void;
  setPaused: (value: boolean) => void;
  setSplitView: (value: boolean) => void;
  setViewMode: (value: DataViewMode) => void;
  applyStatus: (connected: boolean, running: boolean, error: string | null) => void;
  setOtaBusy: (value: boolean) => void;
}

const DEFAULT_FORM: SerialForm = {
  port: "",
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
  dtr: false,
  rts: false,
  lineEnding: "none",
  showTimestamp: true,
  hexView: false,
};

function samePorts(a: SerialPortInfo[], b: SerialPortInfo[]): boolean {
  return (
    a.length === b.length &&
    a.every((port, index) => port.name === b[index].name && port.description === b[index].description)
  );
}

export const useSerialStore = create<SerialStore>()(
  persist(
    (set, get) => ({
      ports: [],
      form: { ...DEFAULT_FORM },
      connected: false,
      running: false,
      otaBusy: false,
      error: null,
      lines: [],
      autoScroll: true,
      paused: false,
      splitView: false,
      viewMode: "text",
      bytesReceived: 0,
      bytesSent: 0,

      setForm: (form) => set((s) => ({ form: { ...s.form, ...form } })),

      refreshPorts: async () => {
        try {
          const ports = await listSerialPorts();
          // 列表未变化时不做无意义的状态刷新（热插拔轮询每 2s 触发一次）
          if (!samePorts(ports, get().ports)) {
            set({ ports });
          }
          // 当前选择的端口不存在时自动切到第一个可用端口
          const { form } = get();
          if ((!form.port || !ports.some((p) => p.name === form.port)) && ports.length > 0) {
            set({ form: { ...form, port: ports[0].name } });
          }
        } catch (error) {
          useLogStore.getState().addLog("error", `枚举串口失败: ${error}`);
        }
      },

      connect: async () => {
        const { form } = get();
        if (!form.port) {
          useLogStore.getState().addLog("warn", "请先选择串口");
          return;
        }
        const addLog = useLogStore.getState().addLog;
        try {
          await connectSerial({
            type: "local",
            port: form.port,
            baud_rate: form.baudRate,
            data_bits: form.dataBits,
            stop_bits: form.stopBits,
            parity: form.parity,
            flow_control: form.flowControl,
            dtr: form.dtr,
            rts: form.rts,
          });
          await startSerial();
          set({ connected: true, running: true, error: null, bytesReceived: 0, bytesSent: 0 });
          addLog("success", `已连接 ${form.port} @ ${form.baudRate}`);
        } catch (error) {
          set({ connected: false, running: false, error: String(error) });
          addLog("error", `连接失败: ${error}`);
        }
      },

      disconnect: async () => {
        try {
          await stopSerial();
          await disconnectSerial();
          set({ connected: false, running: false });
          useLogStore.getState().addLog("info", "已断开串口");
        } catch (error) {
          useLogStore.getState().addLog("error", `断开失败: ${error}`);
        }
      },

      startReceiving: async () => {
        try {
          await startSerial();
          set({ running: true, error: null });
          useLogStore.getState().addLog("info", "恢复接收串口数据");
        } catch (error) {
          useLogStore.getState().addLog("error", `恢复接收失败: ${error}`);
        }
      },

      stopReceiving: async () => {
        try {
          await stopSerial();
          set({ running: false });
          useLogStore.getState().addLog("info", "已暂停接收串口数据");
        } catch (error) {
          useLogStore.getState().addLog("error", `暂停接收失败: ${error}`);
        }
      },

      send: async (text, lineEnding) => {
        if (!text) return;
        const ending = lineEnding ?? get().form.lineEnding;
        const suffix = LINE_ENDING_BYTES[ending];
        try {
          await writeSerialString(text, ending === "none" ? undefined : ending);
          const bytes = Array.from(new TextEncoder().encode(text + suffix));
          set((s) => ({
            bytesSent: s.bytesSent + bytes.length,
            lines: [
              ...s.lines.slice(-MAX_LINES + 1),
              { id: nextSerialLineId(), text, bytes, timestamp: Date.now(), direction: "tx" as const },
            ],
          }));
        } catch (error) {
          useLogStore.getState().addLog("error", `发送失败: ${error}`);
        }
      },

      sendBytes: async (bytes) => {
        if (bytes.length === 0) return;
        try {
          await writeSerial(bytes);
          const text = bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
          set((s) => ({
            bytesSent: s.bytesSent + bytes.length,
            lines: [
              ...s.lines.slice(-MAX_LINES + 1),
              {
                id: nextSerialLineId(),
                text: `HEX: ${text}`,
                bytes,
                timestamp: Date.now(),
                direction: "tx" as const,
              },
            ],
          }));
        } catch (error) {
          useLogStore.getState().addLog("error", `发送失败: ${error}`);
        }
      },

      addLines: (newLines) =>
        set((s) => {
          const received = newLines
            .filter((l) => l.direction === "rx")
            .reduce((sum, l) => sum + l.bytes.length, 0);
          return {
            lines: [...s.lines, ...newLines].slice(-MAX_LINES),
            bytesReceived: s.bytesReceived + received,
          };
        }),

      clear: () => set({ lines: [] }),
      setAutoScroll: (value) => set({ autoScroll: value }),
      setPaused: (value) => set({ paused: value }),
      setSplitView: (value) => set({ splitView: value }),
      setViewMode: (value) => set({ viewMode: value }),
      applyStatus: (connected, running, error) => set({ connected, running, error }),
      setOtaBusy: (value) => set({ otaBusy: value }),
    }),
    {
      name: "ota-host-serial",
      // 兼容旧版本持久化数据：缺失字段用默认值补齐
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<{
          form: Partial<SerialForm>;
          autoScroll: boolean;
          splitView: boolean;
          viewMode: unknown;
        }>;
        return {
          ...current,
          autoScroll: saved.autoScroll ?? current.autoScroll,
          splitView: saved.splitView ?? current.splitView,
          viewMode: normalizeDataViewMode(saved.viewMode) ?? current.viewMode,
          form: { ...current.form, ...saved.form },
        };
      },
      partialize: (state) => ({
        form: state.form,
        autoScroll: state.autoScroll,
        splitView: state.splitView,
        viewMode: state.viewMode,
      }),
    }
  )
);
