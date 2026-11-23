// 本文件是工作台注册表：导出 WORKSPACE_REGISTRY / WORKSPACE_BY_MODE 数据，
// 里面的 lazy() 只是表项的值，对它做 fast refresh 没有意义。
/* eslint-disable react-refresh/only-export-components */
import { lazy, type ComponentType } from "react";
import { Plug2, Radio, Rocket, Zap, type LucideIcon } from "lucide-react";
import type { AppMode } from "@/stores/appStore";

// 工作台按需加载：图标同步渲染（模式轨道要立即显示），工作区本体延迟到切换时拉取
const SerialMode = lazy(() => import("./SerialMode").then((m) => ({ default: m.SerialMode })));
const OtaMode = lazy(() => import("./OtaMode").then((m) => ({ default: m.OtaMode })));
const RttMode = lazy(() => import("./RttMode").then((m) => ({ default: m.RttMode })));
const FlashMode = lazy(() => import("./FlashMode").then((m) => ({ default: m.FlashMode })));

export interface WorkspaceUi {
  id: AppMode;
  label: string;
  navigationIcon: LucideIcon;
  view: ComponentType;
}

export const WORKSPACE_REGISTRY: WorkspaceUi[] = [
  {
    id: "serial",
    label: "串口监视",
    navigationIcon: Plug2,
    view: SerialMode,
  },
  {
    id: "ota",
    label: "OTA 升级",
    navigationIcon: Rocket,
    view: OtaMode,
  },
  {
    id: "rtt",
    label: "RTT 终端",
    navigationIcon: Radio,
    view: RttMode,
  },
  {
    id: "flash",
    label: "固件烧录",
    navigationIcon: Zap,
    view: FlashMode,
  },
];

export const WORKSPACE_BY_MODE = Object.fromEntries(
  WORKSPACE_REGISTRY.map((workspace) => [workspace.id, workspace])
) as Record<AppMode, WorkspaceUi>;
