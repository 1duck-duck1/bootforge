import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** 轻量 tooltip：纯 CSS hover 显示（v1 不引入 Radix） */
export function Tooltip({
  label,
  children,
  className,
  placement = "bottom",
}: {
  label: string;
  children: ReactNode;
  className?: string;
  /** 气泡位置：默认下方居中；左侧窄导航用 right，避免长文案被视口左边缘裁掉 */
  placement?: "bottom" | "right";
}) {
  return (
    <span className={cn("group/tooltip relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-50 whitespace-nowrap rounded-md px-2 py-1 text-xs",
          "bg-foreground text-background opacity-0 shadow-md transition-opacity duration-100",
          "group-hover/tooltip:opacity-100",
          placement === "right"
            ? "left-full top-1/2 ml-2 -translate-y-1/2"
            : "left-1/2 top-full mt-1.5 -translate-x-1/2"
        )}
      >
        {label}
      </span>
    </span>
  );
}
