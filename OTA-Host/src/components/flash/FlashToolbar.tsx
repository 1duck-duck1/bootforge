import { Database, FolderOpen, Loader2, RefreshCw, Zap } from "lucide-react";
import { useFlashStore, type FlashAddressMode } from "@/stores/flashStore";
import { useOtaStore } from "@/stores/otaStore";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { PHASE_LABELS } from "./phaseLabels";

const ADDRESS_MODES: { value: FlashAddressMode; label: string }[] = [
  { value: "primary", label: "Primary 主槽" },
  { value: "secondary", label: "Secondary 副槽" },
  { value: "custom", label: "自定义地址" },
];

/** 烧录工具栏：打开/解析固件、目标槽位、读取槽位、进度与烧录入口 */
export function FlashToolbar() {
  const connected = useOtaStore((s) => s.connected);
  const readingSlots = useOtaStore((s) => s.readingSlots);
  const readSlots = useOtaStore((s) => s.readSlots);

  const firmwarePath = useFlashStore((s) => s.firmwarePath);
  const imageInfo = useFlashStore((s) => s.imageInfo);
  const flashing = useFlashStore((s) => s.flashing);
  const inspecting = useFlashStore((s) => s.inspecting);
  const progress = useFlashStore((s) => s.progress);
  const addressMode = useFlashStore((s) => s.addressMode);
  const selectFirmware = useFlashStore((s) => s.selectFirmware);
  const inspect = useFlashStore((s) => s.inspect);
  const setAddressMode = useFlashStore((s) => s.setAddressMode);
  const validateFlash = useFlashStore((s) => s.validateFlash);
  const flash = useFlashStore((s) => s.flash);

  const percent = progress ? Math.round(progress.progress * 100) : 0;
  const phaseLabel = progress ? (PHASE_LABELS[progress.phase] ?? progress.phase) : null;
  const firmwareFileName = firmwarePath?.split(/[\\/]/).pop();
  const validationError = validateFlash(imageInfo?.file_size);
  const canFlash = !flashing && validationError === null;
  const flashHint = validationError ?? "一键烧录";

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/70 bg-muted/30 px-2">
      <Tooltip label="打开固件文件">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => void selectFirmware()}
          disabled={flashing}
        >
          <FolderOpen className="h-4 w-4" />
        </Button>
      </Tooltip>

      {firmwarePath && (
        <Tooltip label="重新解析固件">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => void inspect()}
            disabled={inspecting || flashing}
          >
            <RefreshCw className={cn("h-4 w-4", inspecting && "animate-spin")} />
          </Button>
        </Tooltip>
      )}

      <div className="mx-1 h-6 w-px bg-border" />

      <div className="flex items-center gap-1.5">
        <span className="hidden text-xs text-muted-foreground min-[1000px]:inline">烧录目标:</span>
        <Select
          value={addressMode}
          onChange={(event) => setAddressMode(event.target.value as FlashAddressMode)}
          disabled={flashing}
          className="h-8 w-[132px] text-xs"
          aria-label="烧录目标"
        >
          {ADDRESS_MODES.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </Select>
      </div>

      <div className="mx-1 h-6 w-px bg-border" />

      <Tooltip label="读取设备主/副槽状态">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-2.5 text-xs"
          onClick={() => void readSlots()}
          disabled={!connected || readingSlots || flashing}
        >
          {readingSlots ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Database className="h-4 w-4" />
          )}
          读取槽位
        </Button>
      </Tooltip>

      <div className="ml-auto flex min-w-0 items-center gap-3">
        {flashing && progress ? (
          <div className="flex items-center gap-2" title={progress.message}>
            <span
              className={cn(
                "text-[11px] font-medium",
                progress.phase === "complete"
                  ? "text-success"
                  : progress.phase === "error"
                    ? "text-destructive"
                    : "text-foreground"
              )}
            >
              {phaseLabel}
              {progress.phase !== "complete" && percent > 0 ? ` ${percent}%` : ""}
            </span>
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-200",
                  progress.phase === "error"
                    ? "bg-destructive"
                    : progress.phase === "complete"
                      ? "bg-success"
                      : "bg-primary"
                )}
                style={{ width: `${Math.max(2, percent)}%` }}
              />
            </div>
          </div>
        ) : (
          firmwarePath && (
            <span
              className="hidden max-w-[240px] truncate text-xs text-muted-foreground min-[1100px]:inline"
              title={firmwarePath}
            >
              {firmwareFileName}
            </span>
          )
        )}

        <Tooltip label={flashHint}>
          <Button size="sm" className="h-8 text-xs" onClick={() => void flash()} disabled={!canFlash}>
            {flashing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Zap className="h-3.5 w-3.5" />
            )}
            {flashing ? "烧录中…" : "烧录"}
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
