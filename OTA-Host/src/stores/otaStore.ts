import { create } from "zustand";
import { persist } from "zustand/middleware";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  connectTarget,
  disconnectProbe,
  getChipInfo,
  getConnectionStatus,
  inspectImage,
  listProbes,
  readSlotStatus,
  searchChips,
  signFirmware,
  type ChipInfo,
  type ConnectionInfo,
  type ImageInfo,
  type ProbeInfo,
  type SignResult,
  type SlotStatus,
} from "@/lib/tauri";
import { useLogStore } from "./logStore";
import { useSettingsStore } from "./settingsStore";

/** 签名表单只保留与本次固件相关的项，工具链/分区参数在设置中心统一维护 */
export const DEFAULT_SIGN_FORM: SignForm = {
  inputPath: "",
  outputPath: "",
  version: "1.0.0",
  securityCounter: "0",
};

export interface SignForm {
  inputPath: string;
  outputPath: string;
  version: string;
  /** 防回滚安全计数器；0 表示不递增（同安全等级重刷）。 */
  securityCounter: string;
}

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
  // 目标芯片
  selectedChip: string;
  chipInfo: ChipInfo | null;
  chipInfoError: string | null;
  chipResults: string[];
  searchingChips: boolean;
  // 双槽状态
  slotStatuses: SlotStatus[];
  slotsError: string | null;
  readingSlots: boolean;

  setForm: (form: Partial<SignForm>) => void;
  sign: () => Promise<void>;
  inspect: (path?: string | null) => Promise<ImageInfo | null>;
  refreshProbes: () => Promise<void>;
  setSelectedProbe: (probeId: string) => void;
  setSelectedChip: (chip: string) => void;
  searchChipOptions: (query: string) => Promise<void>;
  loadChipInfo: (chip?: string) => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  checkConnection: () => Promise<void>;
  readSlots: () => Promise<void>;
  clearLogs: () => void;
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
      selectedChip: "",
      chipInfo: null,
      chipInfoError: null,
      chipResults: [],
      searchingChips: false,
      slotStatuses: [],
      slotsError: null,
      readingSlots: false,

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
        const counterText = (form.securityCounter ?? "0").trim();
        const counter = Number(counterText);
        if (!/^\d+$/.test(counterText) || counter > 0xFFFFFFFF) {
          addLog("warn", "安全计数器必须是 0..4294967295 的整数");
          return;
        }
        if (counter > 4096) {
          addLog("warn", "安全计数器超出设备 OTP 容量（0..4096）");
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
            security_counter: counter,
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

      setSelectedChip: (chip) => {
        if (chip === get().selectedChip) return;
        set({ selectedChip: chip, chipInfo: null, chipInfoError: null, chipResults: [] });
        void get().loadChipInfo(chip);
      },

      searchChipOptions: async (query) => {
        const needle = query.trim();
        if (!needle) {
          set({ chipResults: [] });
          return;
        }
        set({ searchingChips: true });
        try {
          const chipResults = await searchChips(needle);
          set({ chipResults });
        } catch {
          set({ chipResults: [] });
        } finally {
          set({ searchingChips: false });
        }
      },

      loadChipInfo: async (chip) => {
        const chipName = chip ?? get().selectedChip;
        if (!chipName) return;
        try {
          const chipInfo = await getChipInfo(chipName);
          set({ chipInfo, chipInfoError: null });
        } catch (error) {
          set({ chipInfo: null, chipInfoError: String(error) });
          useLogStore.getState().addLog("warn", `读取芯片信息失败: ${error}`);
        }
      },

      connect: async () => {
        const { selectedProbeId, selectedChip } = get();
        const addLog = useLogStore.getState().addLog;
        if (!selectedChip) {
          addLog("warn", "请先选择目标芯片");
          return;
        }
        if (!selectedProbeId) {
          addLog("warn", "请先选择探针");
          return;
        }
        set({ connecting: true });
        try {
          const target = await connectTarget(selectedProbeId, selectedChip);
          const status = await getConnectionStatus();
          set({ connected: status.connected, connectionInfo: status.info });
          void get().loadChipInfo(target.name);
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

      clearLogs: () => set({ signLogs: [] }),
    }),
    {
      name: "ota-host-ota",
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<{
          form: Partial<SignForm>;
        }>;
        return {
          ...current,
          form: { ...current.form, ...saved.form },
        };
      },
      partialize: (state) => ({
        form: state.form,
      }),
    }
  )
);
