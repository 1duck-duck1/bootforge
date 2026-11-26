import { create } from "zustand";
import { persist } from "zustand/middleware";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  flashFirmware,
  inspectImage,
  type FlashProgressEvent,
  type ImageInfo,
} from "@/lib/tauri";
import { parseHexNumber } from "@/lib/hex";
import { formatBytes } from "@/lib/utils";
import { useLogStore } from "./logStore";
import { useOtaStore } from "./otaStore";
import { useSettingsStore } from "./settingsStore";

export type FlashAddressMode = "primary" | "secondary" | "custom";

interface FlashStore {
  firmwarePath: string;
  imageInfo: ImageInfo | null;
  inspecting: boolean;
  addressMode: FlashAddressMode;
  customAddress: string;
  verify: boolean;
  reset: boolean;
  flashing: boolean;
  progress: FlashProgressEvent | null;
  logs: string[];

  setFirmwarePath: (path: string) => void;
  selectFirmware: () => Promise<void>;
  clearFirmware: () => void;
  inspect: () => Promise<void>;
  setAddressMode: (mode: FlashAddressMode) => void;
  setCustomAddress: (value: string) => void;
  setOptions: (options: { verify?: boolean; reset?: boolean }) => void;
  resolveAddress: () => number | null;
  validateFlash: (firmwareSize?: number) => string | null;
  flash: () => Promise<void>;
  clearLogs: () => void;
}

export const useFlashStore = create<FlashStore>()(
  persist(
    (set, get) => ({
      firmwarePath: "",
      imageInfo: null,
      inspecting: false,
      addressMode: "secondary",
      customAddress: "0x08020000",
      verify: true,
      reset: true,
      flashing: false,
      progress: null,
      logs: [],

      setFirmwarePath: (firmwarePath) => set({ firmwarePath, imageInfo: null }),

      selectFirmware: async () => {
        const path = await open({
          title: "选择固件镜像（.bin）",
          multiple: false,
          directory: false,
          filters: [{ name: "固件镜像", extensions: ["bin"] }],
        });
        if (typeof path !== "string") return;
        set({ firmwarePath: path, imageInfo: null });
        await get().inspect();
      },

      clearFirmware: () =>
        set({ firmwarePath: "", imageInfo: null, progress: null, inspecting: false }),

      inspect: async () => {
        const path = get().firmwarePath;
        if (!path) {
          set({ imageInfo: null });
          return;
        }
        set({ inspecting: true });
        try {
          const info = await inspectImage(path);
          set({ imageInfo: info });
        } catch (error) {
          set({ imageInfo: null });
          useLogStore.getState().addLog("warn", `解析固件失败: ${error}`);
        } finally {
          set({ inspecting: false });
        }
      },

      setAddressMode: (addressMode) => set({ addressMode }),
      setCustomAddress: (customAddress) => set({ customAddress }),
      setOptions: (options) =>
        set((state) => ({
          verify: options.verify ?? state.verify,
          reset: options.reset ?? state.reset,
        })),

      resolveAddress: () => {
        const { addressMode, customAddress } = get();
        const { partition } = useSettingsStore.getState();
        if (addressMode === "primary") return partition.primaryBase;
        if (addressMode === "secondary") return partition.secondaryBase;
        return parseHexNumber(customAddress);
      },

      /** 烧录前安全检查：地址、引导区、槽容量与芯片 Flash 范围 */
      validateFlash: (firmwareSize) => {
        const { firmwarePath, imageInfo, addressMode } = get();
        if (!firmwarePath) return "请先选择固件文件";
        if (!useOtaStore.getState().connected) return "请先连接调试探针";

        const address = get().resolveAddress();
        if (address === null) return "烧录地址无效，请检查自定义地址（例如 0x08020000）";
        if (address % 4 !== 0) return "烧录地址需 4 字节对齐";

        const { partition } = useSettingsStore.getState();
        if (address < partition.primaryBase) {
          return `0x${address.toString(16).toUpperCase()} 位于引导区，禁止覆盖（Primary 从 0x${partition.primaryBase.toString(16).toUpperCase()} 开始）`;
        }

        const size = firmwareSize ?? imageInfo?.file_size;
        if (size == null) return null;

        if (addressMode !== "custom" && size > partition.slotSize) {
          return `固件大小 ${formatBytes(size)} 超过槽容量 ${formatBytes(partition.slotSize)}`;
        }

        const chipInfo = useOtaStore.getState().chipInfo;
        const flashRegions = chipInfo?.memory_regions.filter((region) => region.kind === "Flash") ?? [];
        if (flashRegions.length > 0) {
          const fits = flashRegions.some(
            (region) => address >= region.address && address + size <= region.address + region.size
          );
          if (!fits) return `固件范围超出 ${chipInfo?.name ?? "所选芯片"} 的 Flash 区域`;
        }

        return null;
      },

      flash: async () => {
        const addLog = useLogStore.getState().addLog;
        const { firmwarePath, verify, reset } = get();

        if (!firmwarePath) {
          addLog("warn", "请先选择要烧录的固件文件");
          return;
        }

        let error = get().validateFlash();
        if (error) {
          addLog("warn", error);
          return;
        }

        // 地址等基础检查通过后，确保固件已解析出大小再校验容量/范围
        if (!get().imageInfo) {
          await get().inspect();
          if (!get().imageInfo) {
            addLog("warn", "无法解析固件文件，已取消烧录");
            return;
          }
        }

        error = get().validateFlash();
        if (error) {
          addLog("warn", error);
          return;
        }

        const address = get().resolveAddress();
        if (address === null) return;

        set({ flashing: true, progress: null, logs: [] });

        let unlisten: UnlistenFn | null = null;
        try {
          unlisten = await listen<FlashProgressEvent>("flash-progress", (event) => {
            const progress = event.payload;
            const phaseChanged =
              progress.phase !== get().progress?.phase ||
              ["complete", "error"].includes(progress.phase);
            set((state) => ({
              progress,
              logs: phaseChanged
                ? [...state.logs.slice(-200), progress.message]
                : state.logs,
            }));
            if (phaseChanged) {
              addLog(
                progress.phase === "error"
                  ? "error"
                  : progress.phase === "complete"
                    ? "success"
                    : "info",
                progress.message
              );
            }
          });

          await flashFirmware({
            bin_path: firmwarePath,
            address,
            verify,
            reset_after: reset,
          });

          addLog(
            "success",
            `烧录完成: ${firmwarePath} -> 0x${address.toString(16).toUpperCase()}`
          );
        } catch (error) {
          addLog("error", `烧录失败: ${error}`);
          set((state) => ({ logs: [...state.logs, `错误: ${error}`] }));
        } finally {
          if (unlisten) unlisten();
          set({ flashing: false });
        }
      },

      clearLogs: () => set({ logs: [], progress: null }),
    }),
    {
      name: "ota-host-flash",
      partialize: (state) => ({
        firmwarePath: state.firmwarePath,
        addressMode: state.addressMode,
        customAddress: state.customAddress,
        verify: state.verify,
        reset: state.reset,
      }),
    }
  )
);
