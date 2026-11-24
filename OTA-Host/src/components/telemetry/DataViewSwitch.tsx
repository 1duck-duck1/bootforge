import type { ComponentType } from "react";
import { Columns2, LineChart, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DataViewMode } from "@/lib/dataView";

interface DataViewOption {
  value: DataViewMode;
  label: string;
  icon: ComponentType<{ className?: string }>;
  title: string;
}

const OPTIONS: readonly DataViewOption[] = [
  { value: "text", label: "文本", icon: Terminal, title: "仅显示文本" },
  { value: "split", label: "分屏", icon: Columns2, title: "文本 + 图表分屏" },
  { value: "chart", label: "图表", icon: LineChart, title: "仅显示图表" },
];

/** 串口 / RTT 共用的「文本 · 分屏 · 图表」视图切换 */
export function DataViewSwitch({
  value,
  onChange,
}: {
  value: DataViewMode;
  onChange: (value: DataViewMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="数据视图"
      className="flex items-center rounded-lg border border-border/70 p-0.5"
    >
      {OPTIONS.map((option) => {
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
            title={option.title}
            className={cn(
              "flex h-6 items-center gap-1 rounded-md px-2 text-[11px] transition-colors",
              value === option.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
          >
            <Icon className="h-3 w-3" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
