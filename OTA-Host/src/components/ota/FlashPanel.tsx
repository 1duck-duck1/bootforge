import { useEffect, useRef } from "react";
import { CircuitBoard, Loader2 } from "lucide-react";
import { useOtaStore, type FlashTarget } from "@/stores/otaStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { ProbeConnector } from "@/components/probe/ProbeConnector";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function hex(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;
}

const PHASE_LABELS: Record<string, string> = {
  init: "准备",
  preverify: "预校验",
  erase: "擦除",
  program: "编程",
  verify: "校验",
  fill: "填充",
  finishing: "收尾",
  reset: "复位",
  complete: "完成",
  info: "信息",
};

export function FlashPanel() {
  const form = useOtaStore((s) => s.form);
  const result = useOtaStore((s) => s.result);
  const connected = useOtaStore((s) => s.connected);

  const flashTarget = useOtaStore((s) => s.flashTarget);
  const flashVerify = useOtaStore((s) => s.flashVerify);
  const flashReset = useOtaStore((s) => s.flashReset);
  const flashing = useOtaStore((s) => s.flashing);
  const flashProgress = useOtaStore((s) => s.flashProgress);
  const flashLogs = useOtaStore((s) => s.flashLogs);
  const setFlashTarget = useOtaStore((s) => s.setFlashTarget);
  const setFlashOptions = useOtaStore((s) => s.setFlashOptions);
  const flash = useOtaStore((s) => s.flash);
  const partition = useSettingsStore((s) => s.partition);

  const binPath = result?.output_path ?? form.outputPath;
  const slotOptions: { value: FlashTarget; label: string; hint: string }[] = [
    { value: "primary", label: "Primary 主槽", hint: hex(partition.primaryBase) },
    { value: "secondary", label: "Secondary 副槽", hint: hex(partition.secondaryBase) },
  ];
  const address = flashTarget === "primary" ? partition.primaryBase : partition.secondaryBase;

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [flashLogs]);

  const phaseLabel = flashProgress ? (PHASE_LABELS[flashProgress.phase] ?? flashProgress.phase) : null;
  const percent = flashProgress ? Math.round(flashProgress.progress * 100) : 0;
  const showProgress = flashing || flashProgress !== null;

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center gap-2">
        <CircuitBoard className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">烧录到设备</h2>
      </div>

      {/* 探针连接 */}
      <ProbeConnector disabled={flashing} compact />

      <p className="truncate text-[11px] text-muted-foreground" title={binPath}>
        固件：{binPath || "（先在左侧完成签名）"}
      </p>

      {/* 槽选择 */}
      <div className="grid grid-cols-2 gap-2">
        {slotOptions.map((option) => {
          const active = flashTarget === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => setFlashTarget(option.value)}
              disabled={flashing}
              className={cn(
                "flex flex-col items-start gap-0.5 rounded-lg border p-2.5 text-left transition-colors",
                active
                  ? "border-primary bg-primary/10"
                  : "border-border bg-card hover:bg-accent"
              )}
            >
              <span className={cn("text-xs font-semibold", active && "text-primary")}>
                {option.label}
              </span>
              <span className="terminal-font text-[10.5px] text-muted-foreground">{option.hint}</span>
            </button>
          );
        })}
      </div>

      {/* 烧录选项 */}
      <div className="flex items-center gap-4 text-[11px]">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={flashVerify}
            onChange={(e) => setFlashOptions({ verify: e.target.checked })}
            disabled={flashing}
            className="h-3.5 w-3.5 accent-primary"
          />
          烧录后校验
        </label>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={flashReset}
            onChange={(e) => setFlashOptions({ reset: e.target.checked })}
            disabled={flashing}
            className="h-3.5 w-3.5 accent-primary"
          />
          烧录后复位
        </label>
      </div>

      <Button
        onClick={() => void flash()}
        disabled={flashing || !binPath || !connected}
        className="w-full"
      >
        {flashing ? (
          <>
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            烧录中...
          </>
        ) : (
          `烧录到 ${hex(address)}`
        )}
      </Button>

      {/* 进度条 */}
      {showProgress && flashProgress && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className={cn("font-medium", flashProgress.phase === "complete" ? "text-emerald-600 dark:text-emerald-400" : "text-foreground")}>
              {phaseLabel}
              {flashProgress.phase !== "complete" && percent > 0 ? ` ${percent}%` : ""}
            </span>
            <span className="truncate pl-2 text-muted-foreground" title={flashProgress.message}>
              {flashProgress.message}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-200",
                flashProgress.phase === "complete" ? "bg-emerald-500" : "bg-primary"
              )}
              style={{ width: `${Math.max(2, percent)}%` }}
            />
          </div>
        </div>
      )}

      {/* 烧录日志 */}
      {flashLogs.length > 0 && (
        <div className="max-h-28 overflow-hidden rounded-lg border bg-muted/40">
          <div
            ref={logRef}
            className="terminal-font max-h-28 overflow-y-auto px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground"
          >
            {flashLogs.map((line, index) => (
              <div key={index} className="whitespace-pre-wrap break-all">
                {line}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
