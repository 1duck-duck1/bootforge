import { create } from "zustand";
import { persist } from "zustand/middleware";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  connectTarget,
  disconnectProbe,
  flashFirmware,
  getConnectionStatus,
  inspectImage,
  listProbes,
  readSlotStatus,
  signFirmware,
  type ConnectionInfo,
  type FlashProgressEvent,
  type ImageInfo,
  type ProbeInfo,
  type SignResult,
  type SlotStatus,
} from "@/lib/tauri";
import { useLogStore } from "./logStore";
import { useSettingsStore } from "./settingsStore";
import { useSerialStore } from "./serialStore";

/** 签名表单只保留与本次固件相关的项，工具链/分区参数在设置中心统一维护 */
export const DEFAULT_SIGN_FORM: SignForm = {
  inputPath: "",
  outputPath: "",
  version: "1.0.0",
};

export interface SignForm {
  inputPath: string;
  outputPath: string;
  version: string;
}

export type FlashTarget = "primary" | "secondary";

export type FlowStepStatus = "pending" | "running" | "done" | "failed";

export interface FlowStep {
  id: "sign" | "flash" | "trigger" | "confirm";
  label: string;
  status: FlowStepStatus;
  detail?: string;
}

const FLOW_TEMPLATE: FlowStep[] = [
  { id: "sign", label: "签名并校验镜像", status: "pending" },
  { id: "flash", label: "烧录到 Secondary 副槽", status: "pending" },
  { id: "trigger", label: "等待应用启动并发送 p", status: "pending" },
  { id: "confirm", label: "等待 MCUboot 完成 swap", status: "pending" },
];

interface OtaStore {
  form: SignForm;
  signing: boolean;
  signLogs: string[];
  result: SignResult | null;
  // 镜像校验
  imageInfo: ImageInfo | null;
  imageInfoError: string | null;
  inspectingImage: boolean;
  // 探针连接（probe-rs）
  probes: ProbeInfo[];
  refreshingProbes: boolean;
  selectedProbeId: string | null;
  connecting: boolean;
  connected: boolean;
  connectionInfo: ConnectionInfo | null;
  // 烧录（probe-rs + FlashProgress）
  flashTarget: FlashTarget;
  flashVerify: boolean;
  flashReset: boolean;
  flashing: boolean;
  flashProgress: FlashProgressEvent | null;
  flashLogs: string[];
  // 双槽状态
  slotStatuses: SlotStatus[];
  slotsError: string | null;
  readingSlots: boolean;
  // 一键升级
  flowSteps: FlowStep[];
  flowRunning: boolean;
  flowError: string | null;

  setForm: (form: Partial<SignForm>) => void;
  sign: () => Promise<void>;
  inspect: (path?: string | null) => Promise<ImageInfo | null>;
  refreshProbes: () => Promise<void>;
  setSelectedProbe: (probeId: string) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  checkConnection: () => Promise<void>;
  setFlashTarget: (target: FlashTarget) => void;
  setFlashOptions: (options: { verify?: boolean; reset?: boolean }) => void;
  flashSlot: (target: FlashTarget, options?: { resetAfter?: boolean }) => Promise<boolean>;
  flash: () => Promise<void>;
  readSlots: () => Promise<void>;
  runOneClick: () => Promise<void>;
  clearLogs: () => void;
}

/** 当前串口最新一行的 id，用于只匹配之后的新日志 */
function lastLineId(): number {
  return useSerialStore.getState().lines.reduce((max, line) => Math.max(max, line.id), 0);
}

/** 轮询串口行，等待匹配 pattern 的新日志（id 大于 afterId） */
async function waitForLine(pattern: RegExp, timeoutMs: number, afterId: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const line = useSerialStore
      .getState()
      .lines.find((item) => item.id > afterId && item.direction === "rx" && pattern.test(item.text));
    if (line) return line.text;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`等待串口日志超时（${Math.round(timeoutMs / 1000)}s）`);
}

export const useOtaStore = create<OtaStore>()(
  persist(
    (set, get) => ({
      form: { ...DEFAULT_SIGN_FORM },
      signing: false,
      signLogs: [],
      result: null,
      imageInfo: null,
      imageInfoError: null,
      inspectingImage: false,
      probes: [],
      refreshingProbes: false,
      selectedProbeId: null,
      connecting: false,
      connected: false,
      connectionInfo: null,
      flashTarget: "primary",
      flashVerify: true,
      flashReset: true,
      flashing: false,
      flashProgress: null,
      flashLogs: [],
      slotStatuses: [],
      slotsError: null,
      readingSlots: false,
      flowSteps: FLOW_TEMPLATE.map((step) => ({ ...step })),
      flowRunning: false,
      flowError: null,

      setForm: (form) => set((s) => ({ form: { ...s.form, ...form } })),

      inspect: async (path) => {
        const target = path ?? (get().form.outputPath || get().form.inputPath);
        if (!target) {
          set({ imageInfo: null, imageInfoError: null });
          return null;
        }
        set({ inspectingImage: true, imageInfoError: null });
        try {
          const info = await inspectImage(target);
          set({ imageInfo: info });
          if (info.valid && info.hash_match === false) {
            useLogStore.getState().addLog("warn", `镜像哈希校验失败: ${target}`);
          }
          return info;
        } catch (error) {
          set({ imageInfo: null, imageInfoError: String(error) });
          return null;
        } finally {
          set({ inspectingImage: false });
        }
      },

      sign: async () => {
        const { form } = get();
        const { toolchain, partition } = useSettingsStore.getState();
        const addLog = useLogStore.getState().addLog;
        if (!form.inputPath) {
          addLog("warn", "请先选择固件文件");
          return;
        }
        if (!form.outputPath) {
          addLog("warn", "请填写输出路径");
          return;
        }

        set({ signing: true, signLogs: [], result: null });

        let unlisten: UnlistenFn | null = null;
        try {
          unlisten = await listen<string>("ota-sign-log", (event) => {
            set((s) => ({ signLogs: [...s.signLogs.slice(-500), event.payload] }));
          });

          const result = await signFirmware({
            input_path: form.inputPath,
            output_path: form.outputPath,
            version: form.version,
            key_path: toolchain.keyPath,
            header_size: partition.headerSize,
            slot_size: partition.slotSize,
            align: partition.align,
            python: toolchain.python,
            imgtool: toolchain.imgtool,
          });

          set({ result });
          addLog("success", `签名完成: ${result.output_path} (${result.size} 字节)`);
          await get().inspect(result.output_path);
        } catch (error) {
          addLog("error", `签名失败: ${error}`);
          set((s) => ({ signLogs: [...s.signLogs, `错误: ${error}`] }));
        } finally {
          if (unlisten) unlisten();
          set({ signing: false });
        }
      },

      refreshProbes: async () => {
        const addLog = useLogStore.getState().addLog;
        set({ refreshingProbes: true });
        try {
          const probes = await listProbes();
          set((s) => ({
            probes,
            // 已选探针不在新列表里时清掉选择
            selectedProbeId: probes.some((p) => p.probe_id === s.selectedProbeId)
              ? s.selectedProbeId
              : (probes[0]?.probe_id ?? null),
          }));
        } catch (error) {
          addLog("error", `探针枚举失败: ${error}`);
        } finally {
          set({ refreshingProbes: false });
        }
      },

      setSelectedProbe: (probeId) => set({ selectedProbeId: probeId }),

      connect: async () => {
        const { selectedProbeId } = get();
        const addLog = useLogStore.getState().addLog;
        if (!selectedProbeId) {
          addLog("warn", "请先选择探针");
          return;
        }
        set({ connecting: true });
        try {
          const target = await connectTarget(selectedProbeId);
          const status = await getConnectionStatus();
          set({ connected: status.connected, connectionInfo: status.info });
          const chipId =
            target.chip_id !== null ? `，芯片ID 0x${target.chip_id.toString(16).toUpperCase()}` : "";
          addLog("success", `探针已连接: ${target.name}${chipId}`);
        } catch (error) {
          addLog("error", `连接失败: ${error}`);
          set({ connected: false, connectionInfo: null });
        } finally {
          set({ connecting: false });
        }
      },

      disconnect: async () => {
        const addLog = useLogStore.getState().addLog;
        try {
          await disconnectProbe();
          set({ connected: false, connectionInfo: null, slotStatuses: [] });
          addLog("info", "探针已断开");
        } catch (error) {
          addLog("error", `断开失败: ${error}`);
        }
      },

      checkConnection: async () => {
        try {
          const status = await getConnectionStatus();
          set({ connected: status.connected, connectionInfo: status.info });
        } catch {
          // 后端未就绪时忽略
        }
      },

      setFlashTarget: (target) => set({ flashTarget: target }),

      setFlashOptions: (options) =>
        set((s) => ({
          flashVerify: options.verify ?? s.flashVerify,
          flashReset: options.reset ?? s.flashReset,
        })),

      flashSlot: async (target, options) => {
        const { form, flashVerify, flashReset, connected } = get();
        const { partition } = useSettingsStore.getState();
        const addLog = useLogStore.getState().addLog;
        const binPath = get().result?.output_path ?? form.outputPath;
        const address = target === "primary" ? partition.primaryBase : partition.secondaryBase;
        const resetAfter = options?.resetAfter ?? flashReset;

        if (!binPath) {
          addLog("warn", "没有可烧录的固件：请先签名或填写输出路径");
          return false;
        }
        if (!connected) {
          addLog("warn", "探针未连接：请先连接调试探针");
          return false;
        }

        set({ flashing: true, flashProgress: null, flashLogs: [] });

        let unlisten: UnlistenFn | null = null;
        try {
          unlisten = await listen<FlashProgressEvent>("flash-progress", (event) => {
            const p = event.payload;
            set((s) => ({
              flashProgress: p,
              // 阶段切换或收尾/完成/失败时记一条日志
              flashLogs:
                p.phase !== s.flashProgress?.phase || ["complete", "error"].includes(p.phase)
                  ? [...s.flashLogs.slice(-200), p.message]
                  : s.flashLogs,
            }));
          });

          await flashFirmware({
            bin_path: binPath,
            address,
            verify: flashVerify,
            reset_after: resetAfter,
          });

          addLog(
            "success",
            `烧录完成: ${binPath} -> 0x${address.toString(16).toUpperCase()}（${
              target === "primary" ? "Primary 主槽" : "Secondary 副槽"
            }）`
          );
          return true;
        } catch (error) {
          addLog("error", `烧录失败: ${error}`);
          set((s) => ({ flashLogs: [...s.flashLogs, `错误: ${error}`] }));
          return false;
        } finally {
          if (unlisten) unlisten();
          set({ flashing: false });
        }
      },

      flash: async () => {
        await get().flashSlot(get().flashTarget);
      },

      readSlots: async () => {
        const addLog = useLogStore.getState().addLog;
        const { connected } = get();
        const { partition } = useSettingsStore.getState();
        if (!connected) {
          addLog("warn", "探针未连接，无法读取槽位状态");
          return;
        }
        set({ readingSlots: true, slotsError: null });
        try {
          const statuses = await readSlotStatus([
            { name: "Primary 主槽", address: partition.primaryBase, size: partition.slotSize },
            { name: "Secondary 副槽", address: partition.secondaryBase, size: partition.slotSize },
          ]);
          set({ slotStatuses: statuses });
          const summary = statuses
            .map((slot) => `${slot.name.split(" ")[0]} ${slot.version ?? "空"}`)
            .join(" · ");
          addLog("info", `槽位状态: ${summary}`);
        } catch (error) {
          set({ slotsError: String(error) });
          addLog("error", `读取槽位状态失败: ${error}`);
        } finally {
          set({ readingSlots: false });
        }
      },

      runOneClick: async () => {
        const addLog = useLogStore.getState().addLog;
        const steps = FLOW_TEMPLATE.map((step) => ({ ...step }));
        set({ flowSteps: steps, flowRunning: true, flowError: null });

        let current: FlowStep["id"] = "sign";
        const setStep = (id: FlowStep["id"], status: FlowStepStatus, detail?: string) =>
          set((s) => ({
            flowSteps: s.flowSteps.map((step) =>
              step.id === id ? { ...step, status, detail: detail ?? step.detail } : step
            ),
          }));

        try {
          // 记录本次流程开始前的最后一行，只匹配之后的新日志
          const afterId = lastLineId();

          // 1. 签名（可选）并校验镜像
          current = "sign";
          setStep("sign", "running");
          const before = get().form;
          if (before.inputPath) {
            if (!before.outputPath) throw new Error("请填写签名输出路径");
            await get().sign();
            if (!get().result) throw new Error("签名失败，请查看 imgtool 输出");
          }
          const binPath = get().result?.output_path || get().form.outputPath;
          if (!binPath) {
            throw new Error("请选择待签名固件，或填写已签名固件路径");
          }
          const info = await get().inspect(binPath);
          if (!info?.valid) throw new Error(info?.message ?? "镜像解析失败");
          if (info.hash_match === false) throw new Error("镜像哈希不匹配，拒绝升级");
          setStep("sign", "done", info.version ? `v${info.version}` : undefined);

          // 2. 烧录副槽（强制复位，便于随后捕获启动横幅）
          current = "flash";
          setStep("flash", "running");
          const flashed = await get().flashSlot("secondary", { resetAfter: true });
          if (!flashed) throw new Error("副槽烧录失败");
          setStep("flash", "done");

          // 3. 等待应用启动并发送 p
          current = "trigger";
          setStep("trigger", "running");
          if (!useSerialStore.getState().connected) {
            throw new Error("串口未连接，无法发送 p 触发升级");
          }
          await waitForLine(/keys:\s*\[p\]|Keil_OTA App/i, 20000, afterId);
          await useSerialStore.getState().send("p", "none");
          // 只匹配发送 p 之后的新日志，避免命中刚才的启动横幅
          const afterP = lastLineId();
          setStep("trigger", "done", "已发送 p");

          // 4. 等待 swap 后新固件启动（应用横幅 / 确认日志）
          current = "confirm";
          setStep("confirm", "running");
          await waitForLine(/=== Keil_OTA App|boot_set_confirmed/i, 30000, afterP);

          // 读取两槽并核对主槽版本，确认 swap 真正生效（而不是回滚到旧镜像）
          if (!get().connected) {
            throw new Error("探针已断开，无法核对升级结果");
          }
          await get().readSlots();
          if (get().slotsError) {
            throw new Error(`升级后槽位读取失败: ${get().slotsError}`);
          }
          const expected = get().imageInfo?.version;
          const primary = get().slotStatuses.find((slot) => slot.name.includes("Primary"));
          if (expected && primary?.version && primary.version !== expected) {
            throw new Error(`主槽版本 ${primary.version} 与目标 ${expected} 不一致，可能已回滚`);
          }
          setStep(
            "confirm",
            "done",
            primary?.version ? `主槽 v${primary.version} 已生效` : "新固件已启动"
          );

          set({ flowRunning: false });
          addLog("success", "一键升级完成，升级后槽位状态已刷新");
        } catch (error) {
          const message = String(error);
          setStep(current, "failed", message);
          set({ flowRunning: false, flowError: message });
          addLog("error", `一键升级中断: ${message}`);
        }
      },

      clearLogs: () => set({ signLogs: [] }),
    }),
    {
      name: "ota-host-ota",
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<{
          form: Partial<SignForm>;
          flashTarget: FlashTarget;
          flashVerify: boolean;
          flashReset: boolean;
        }>;
        return {
          ...current,
          form: { ...current.form, ...saved.form },
          flashTarget: saved.flashTarget ?? current.flashTarget,
          flashVerify: saved.flashVerify ?? current.flashVerify,
          flashReset: saved.flashReset ?? current.flashReset,
        };
      },
      partialize: (state) => ({
        form: state.form,
        flashTarget: state.flashTarget,
        flashVerify: state.flashVerify,
        flashReset: state.flashReset,
      }),
    }
  )
);
