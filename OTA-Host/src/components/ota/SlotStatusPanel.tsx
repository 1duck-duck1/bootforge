import { Database, RefreshCw } from "lucide-react";
import { useOtaStore } from "@/stores/otaStore";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn, formatBytes } from "@/lib/utils";

function hex(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;
}

function Flag({ label, value }: { label: string; value: boolean | null }) {
  const text = value === null ? "—" : value ? "SET" : "UNSET";
  return (
    <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
      {label}
      <span
        className={cn(
          "terminal-font",
          value === null ? "text-muted-foreground/60" : value ? "text-success" : "text-foreground"
        )}
      >
        {text}
      </span>
    </span>
  );
}

export function SlotStatusPanel() {
  const connected = useOtaStore((s) => s.connected);
  const slotStatuses = useOtaStore((s) => s.slotStatuses);
  const slotsError = useOtaStore((s) => s.slotsError);
  const readingSlots = useOtaStore((s) => s.readingSlots);
  const readSlots = useOtaStore((s) => s.readSlots);

  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2">
        <Database className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">设备槽位</h2>
        <Tooltip label={connected ? "读取双槽状态" : "请先连接探针"}>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto h-7 w-7"
            disabled={!connected || readingSlots}
            onClick={() => void readSlots()}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", readingSlots && "animate-spin")} />
          </Button>
        </Tooltip>
      </div>

      {slotsError && (
        <p className="mt-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
          {slotsError}
        </p>
      )}

      {slotStatuses.length === 0 ? (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {connected ? "点击刷新读取槽位状态。" : "连接探针后可读取槽位状态。"}
        </p>
      ) : (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {slotStatuses.map((slot) => (
            <div
              key={slot.name}
              className={cn(
                "flex flex-col gap-1.5 rounded-lg border p-2.5",
                slot.header_valid ? "border-success/30 bg-success/5" : "bg-muted/30"
              )}
            >
              <div className="flex items-baseline gap-1.5">
                <span className="text-xs font-semibold">{slot.name}</span>
                <span className="terminal-font ml-auto text-[10px] text-muted-foreground">
                  {hex(slot.address)}
                </span>
              </div>

              {slot.header_valid ? (
                <>
                  <div className="flex items-baseline gap-1.5">
                    <span className="terminal-font text-sm font-semibold text-success">
                      v{slot.version}
                    </span>
                    <span className="text-[10.5px] text-muted-foreground">
                      {slot.image_size !== null ? formatBytes(slot.image_size) : ""}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <Flag label="image_ok" value={slot.image_ok} />
                    <Flag label="copy_done" value={slot.copy_done} />
                  </div>
                  <p className="truncate text-[10.5px] text-muted-foreground" title={slot.swap_state}>
                    swap: {slot.swap_state}
                  </p>
                </>
              ) : (
                <p className="text-[10.5px] leading-relaxed text-muted-foreground">{slot.message}</p>
              )}

              <p className="text-[10px] text-muted-foreground/70">
                {slot.trailer_valid ? "trailer 已初始化" : "trailer 未初始化"} · 槽{" "}
                {formatBytes(slot.size)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
