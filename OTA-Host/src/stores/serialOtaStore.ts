import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  serialOtaAbort,
  serialOtaDeviceInfo,
  serialOtaFlash,
  type SerialOtaDeviceStatus,
  type SerialOtaProgress,
  type SerialOtaResult,
} from "@/lib/tauri";
import { useLogStore } from "./logStore";
import { useSerialStore } from "./serialStore";

const MAX_LOGS = 400;

interface SerialOtaStore {
  running: boolean;
  phase: string;
  progress: number;
  sent: number;
  total: number;
  logs: string[];
  error: string | null;
  result: SerialOtaResult | null;
  /** 最近一次读取的设备信息 */
  deviceInfo: SerialOtaDeviceStatus | null;
  readingDevice: boolean;
  /** 面板内手动选择的固件；为空时退回签名结果/表单路径 */
  imagePath: string | null;
  setImagePath: (path: string | null) => void;
  start: (imagePath: string) => Promise<void>;
  readDeviceInfo: () => Promise<void>;
  cancel: () => Promise<void>;
  clear: () => void;
}

export const useSerialOtaStore = create<SerialOtaStore>((set, get) => ({
  running: false,
  phase: "idle",
  progress: 0,
  sent: 0,
  total: 0,
  logs: [],
  error: null,
  result: null,
  deviceInfo: null,
  readingDevice: false,
  imagePath: null,

  setImagePath: (path) => set({ imagePath: path }),

  start: async (imagePath) => {
    if (get().running) return;
    const addLog = useLogStore.getState().addLog;

    // 前置条件不满足时在面板内直接给出原因，而不是静默返回
    const fail = (message: string) => {
      set({ running: false, phase: "idle", progress: 0, sent: 0, total: 0, error: message, result: null });
      addLog("error", message);
    };

    if (!useSerialStore.getState().connected) {
      const port = useSerialStore.getState().form.port;
      if (!port) {
        fail("串口未连接：请先在上方选择端口并点击“连接”");
        return;
      }
      set({
        phase: "connecting",
        error: null,
        result: null,
        logs: [`串口未连接，正在自动连接 ${port}...`],
      });
      await useSerialStore.getState().connect();
      if (!useSerialStore.getState().connected) {
        const reason = useSerialStore.getState().error;
        fail(`串口连接失败${reason ? `：${reason}` : ""}`);
        return;
      }
    }

    if (!imagePath) {
      fail("未选择固件：请先在左侧完成 imgtool 签名，或点击“选择”指定已签名 .bin");
      return;
    }

    set({
      running: true,
      phase: "query",
      progress: 0,
      sent: 0,
      total: 0,
      logs: [],
      error: null,
      result: null,
    });
    // 通知串口监视：端口已被 OTA 独占，接收线程即将暂停
    useSerialStore.getState().setOtaBusy(true);

    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<SerialOtaProgress>("serial-ota-progress", (event) => {
        const payload = event.payload;
        set((state) => ({
          phase: payload.phase,
          progress: payload.progress,
          sent: payload.sent,
          total: payload.total,
          logs:
            payload.log && payload.message
              ? [...state.logs.slice(-MAX_LOGS + 1), payload.message]
              : state.logs,
        }));
      });

      const result = await serialOtaFlash(imagePath);
      const summary = `${(result.total_size / 1024).toFixed(1)} KB · CRC32 ${result.crc32
        .toString(16)
        .toUpperCase()
        .padStart(8, "0")} · ${(result.duration_ms / 1000).toFixed(1)} s`;
      const verify = result.verified
        ? `运行版本 v${result.running_version} 校验一致`
        : result.running_version
          ? `运行版本 v${result.running_version} 与目标版本不一致`
          : "未能回连确认运行版本";
      set((state) => ({
        result,
        phase: "complete",
        progress: 1,
        logs: [...state.logs, `升级完成：${summary}`, `校验：${verify}`],
      }));
      addLog(
        result.verified ? "success" : "warn",
        `串口 OTA 完成：${summary}（${verify}）`
      );
    } catch (error) {
      const message = String(error);
      const cancelled = message.includes("已取消");
      set((state) => ({
        error: cancelled ? null : message,
        phase: cancelled ? "cancelled" : "error",
        logs: [...state.logs, cancelled ? "已取消" : `错误：${message}`],
      }));
      addLog(cancelled ? "info" : "error", cancelled ? "串口 OTA 已取消" : `串口 OTA 失败: ${message}`);
    } finally {
      if (unlisten) unlisten();
      set({ running: false });
      useSerialStore.getState().setOtaBusy(false);
      // OTA 独占结束：恢复串口监视的接收线程，避免一直停在“已停止接收”
      const serial = useSerialStore.getState();
      if (serial.connected && !serial.running) {
        await serial.startReceiving();
      }
    }
  },

  readDeviceInfo: async () => {
    if (get().running || get().readingDevice) return;
    const addLog = useLogStore.getState().addLog;
    const serial = useSerialStore.getState();

    if (!serial.connected) {
      if (!serial.form.port) {
        set({ error: "串口未连接：请先选择端口并点击“连接”" });
        return;
      }
      set({ readingDevice: true, error: null });
      await serial.connect();
      if (!useSerialStore.getState().connected) {
        const reason = useSerialStore.getState().error;
        set({
          readingDevice: false,
          error: `串口连接失败${reason ? `：${reason}` : ""}`,
        });
        return;
      }
    } else {
      set({ readingDevice: true, error: null });
    }

    useSerialStore.getState().setOtaBusy(true);
    try {
      const info = await serialOtaDeviceInfo();
      set({ deviceInfo: info, error: null });
      addLog(
        "success",
        `设备状态：主槽 ${
          info.primary_version ? `v${info.primary_version}` : "空"
        }，副槽 ${
          info.secondary_version ? `v${info.secondary_version}` : "空"
        }，${info.swap_state}`
      );
    } catch (error) {
      const message = String(error);
      set({ error: message });
      addLog("error", `读取设备状态失败: ${message}`);
    } finally {
      set({ readingDevice: false });
      useSerialStore.getState().setOtaBusy(false);
      const current = useSerialStore.getState();
      if (current.connected && !current.running) {
        await current.startReceiving();
      }
    }
  },

  cancel: async () => {
    if (!get().running) return;
    useLogStore.getState().addLog("info", "正在取消串口 OTA...");
    try {
      await serialOtaAbort();
    } catch (error) {
      useLogStore.getState().addLog("error", `取消失败: ${error}`);
    }
  },

  clear: () => set({ phase: "idle", progress: 0, sent: 0, total: 0, logs: [], error: null, result: null }),
}));
