import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** 轻量 tooltip：纯 CSS hover 显示（v1 不引入 Radix） */
export function Tooltip({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <span className={cn("group/tooltip relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md px-2 py-1 text-xs",
          "bg-foreground text-background opacity-0 shadow-md transition-opacity duration-100",
          "group-hover/tooltip:opacity-100"
        )}
      >
        {label}
      </span>
    </span>
  );
}
