import { create } from "zustand";
import { persist } from "zustand/middleware";

/** imgtool 工具链配置 */
export interface ToolchainSettings {
  /** Python 可执行命令（可为 PATH 中的 python） */
  python: string;
  /** imgtool.py 路径 */
  imgtool: string;
  /** ECDSA P-256 私钥 PEM */
  keyPath: string;
}

/** Flash 分区配置（与 Keil_OTA_Boot/port/sysflash 保持一致） */
export interface PartitionSettings {
  primaryBase: number;
  secondaryBase: number;
  slotSize: number;
  scratchBase: number;
  scratchSize: number;
  headerSize: number;
  align: number;
}

export const DEFAULT_TOOLCHAIN: ToolchainSettings = {
  python: "python",
  imgtool: "d:\\A_Github\\mcuboot-main\\mcuboot-main\\scripts\\imgtool.py",
  keyPath: "d:\\A_Github\\mcuboot-main\\mcuboot-main\\root-ec-p256.pem",
};

export const DEFAULT_PARTITION: PartitionSettings = {
  primaryBase: 0x08020000,
  secondaryBase: 0x08080000,
  slotSize: 0x60000,
  scratchBase: 0x080e0000,
  scratchSize: 0x20000,
  headerSize: 0x200,
  align: 8,
};

interface SettingsStore {
  toolchain: ToolchainSettings;
  partition: PartitionSettings;
  setToolchain: (value: Partial<ToolchainSettings>) => void;
  setPartition: (value: Partial<PartitionSettings>) => void;
  reset: () => void;
}

/** 全局设置：工具链路径 + 分区参数，持久化到 localStorage 并即时生效 */
export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      toolchain: { ...DEFAULT_TOOLCHAIN },
      partition: { ...DEFAULT_PARTITION },
      setToolchain: (value) => set((s) => ({ toolchain: { ...s.toolchain, ...value } })),
      setPartition: (value) => set((s) => ({ partition: { ...s.partition, ...value } })),
      reset: () => set({ toolchain: { ...DEFAULT_TOOLCHAIN }, partition: { ...DEFAULT_PARTITION } }),
    }),
    { name: "ota-host-settings" }
  )
);

/** 按目标槽取烧录基地址 */
export function slotAddress(target: "primary" | "secondary"): number {
  const { partition } = useSettingsStore.getState();
  return target === "primary" ? partition.primaryBase : partition.secondaryBase;
}
