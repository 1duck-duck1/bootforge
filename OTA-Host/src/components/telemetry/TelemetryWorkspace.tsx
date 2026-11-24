import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { DataViewMode } from "@/lib/dataView";

const MIN_RATIO = 0.25;
const MAX_RATIO = 0.75;

/**
 * 串口 / RTT 共用的数据视图容器：
 * - text：仅文本
 * - chart：仅图表
 * - split：上方文本 / 下方图表，中间分隔条可拖拽调整比例
 */
export function TelemetryWorkspace({
  viewMode,
  text,
  chart,
}: {
  viewMode: DataViewMode;
  text: ReactNode;
  chart: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 文本区占比，仅在分屏模式使用
  const [ratio, setRatio] = useState(0.5);

  if (viewMode !== "split") {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {viewMode === "chart" ? chart : text}
      </div>
    );
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.height === 0) return;
    const next = (event.clientY - rect.top) / rect.height;
    setRatio(Math.min(MAX_RATIO, Math.max(MIN_RATIO, next)));
  };

  return (
    <div
      ref={containerRef}
      className="grid min-h-0 flex-1 overflow-hidden"
      style={{ gridTemplateRows: `minmax(0,${ratio}fr) 6px minmax(0,${1 - ratio}fr)` }}
    >
      <div className="flex min-h-0 flex-col overflow-hidden">{text}</div>

      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整文本与图表高度比例"
        className="group flex cursor-row-resize items-center justify-center"
        onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerMove={handlePointerMove}
      >
        <span className="h-0.5 w-10 rounded-full bg-border transition-colors group-hover:bg-primary" />
      </div>

      <div className="flex min-h-0 flex-col overflow-hidden">{chart}</div>
    </div>
  );
}
