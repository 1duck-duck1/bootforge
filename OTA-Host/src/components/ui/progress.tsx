import { cn } from "@/lib/utils";

/** 轻量进度条：对齐 OmniProbe 的 Progress 视觉（无 Radix 依赖） */
export function Progress({
  value,
  className,
  indicatorClassName,
}: {
  value: number;
  className?: string;
  indicatorClassName?: string;
}) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-primary/20", className)}
    >
      <div
        className={cn("h-full w-full flex-1 bg-primary transition-all duration-200", indicatorClassName)}
        style={{ transform: `translateX(-${100 - clamped}%)` }}
      />
    </div>
  );
}
