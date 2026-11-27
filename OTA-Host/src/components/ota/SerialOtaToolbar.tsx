import { useEffect } from "react";
import { AlertTriangle, Cable, Loader2, RefreshCw } from "lucide-react";
import { useSerialStore } from "@/stores/serialStore";
import { useSerialOtaStore } from "@/stores/serialOtaStore";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { PHASE_LABELS } from "./phaseLabels";

const BAUD_RATES = [115200, 230400, 460800, 921600];

/** 串口 OTA 工具栏：端口/波特率/连接、读取设备、进度。 */
export function SerialOtaToolbar() {
  const ports = useSerialStore((s) => s.ports);
  const form = useSerialStore((s) => s.form);
  const setForm = useSerialStore((s) => s.setForm);
  const connected = useSerialStore((s) => s.connected);
  const serialError = useSerialStore((s) => s.error);
  const connect = useSerialStore((s) => s.connect);
  const disconnect = useSerialStore((s) => s.disconnect);
  const refreshPorts = useSerialStore((s) => s.refreshPorts);

  const running = useSerialOtaStore((s) => s.running);
  const phase = useSerialOtaStore((s) => s.phase);
  const progress = useSerialOtaStore((s) => s.progress);
  const readingDevice = useSerialOtaStore((s) => s.readingDevice);
  const readDeviceInfo = useSerialOtaStore((s) => s.readDeviceInfo);
  const deviceInfo = useSerialOtaStore((s) => s.deviceInfo);

  const percent = Math.round(progress * 100);

  // 端口热插拔：未连接且没有 OTA 任务时每 2s 刷新
  useEffect(() => {
    void refreshPorts();
    const timer = window.setInterval(() => {
      if (!useSerialStore.getState().connected && !useSerialOtaStore.getState().running) {
        void refreshPorts();
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refreshPorts]);

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/70 bg-muted/30 px-2">
      <Cable className="h-4 w-4 shrink-0 text-primary" />

      {connected ? (
        <>
          <span className="ml-1 h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
          <span className="terminal-font text-xs">{form.port}</span>
          <span className="text-xs text-muted-foreground">@{form.baudRate}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs"
            disabled={running}
            onClick={() => void disconnect()}
          >
            断开
          </Button>
        </>
      ) : (
        <>
          <Select
            value={form.port}
            onChange={(e) => setForm({ port: e.target.value })}
            disabled={running}
            className="ml-1 h-8 w-[186px] text-xs"
            aria-label="串口"
          >
            {ports.length === 0 && <option value="">（未检测到串口）</option>}
            {ports.map((port) => (
              <option key={port.name} value={port.name}>
                {port.name}
                {port.description ? ` - ${port.description}` : ""}
              </option>
            ))}
          </Select>
          <Select
            value={String(form.baudRate)}
            onChange={(e) => setForm({ baudRate: Number(e.target.value) })}
            disabled={running}
            className="h-8 w-[104px] text-xs"
            aria-label="波特率"
          >
            {BAUD_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {rate}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            className="h-8 shrink-0 text-xs"
            disabled={!form.port || running}
            onClick={() => void connect()}
          >
            连接
          </Button>
        </>
      )}

      {!connected && form.baudRate !== 115200 && (
        <span className="flex items-center gap-1 text-[10px] text-warning">
          <AlertTriangle className="h-3 w-3" />
          设备固定 115200
        </span>
      )}

      <div className="mx-1 h-6 w-px bg-border" />

      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 px-2.5 text-xs"
        disabled={!connected || running || readingDevice}
        onClick={() => void readDeviceInfo()}
      >
        {readingDevice ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4" />
        )}
        {readingDevice ? "读取中" : "读取设备"}
      </Button>

      <div className="ml-auto flex min-w-0 items-center gap-3">
        {running && progress > 0 ? (
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "text-[11px] font-medium",
                phase === "complete"
                  ? "text-success"
                  : phase === "error"
                    ? "text-destructive"
                    : "text-foreground"
              )}
            >
              {PHASE_LABELS[phase] ?? phase}
              {phase === "data" ? ` ${percent}%` : ""}
            </span>
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-200",
                  phase === "complete"
                    ? "bg-success"
                    : phase === "error"
                      ? "bg-destructive"
                      : "bg-primary"
                )}
                style={{ width: `${Math.max(2, percent)}%` }}
              />
            </div>
          </div>
        ) : serialError ? (
          <span className="max-w-[280px] truncate text-[11px] text-destructive" title={serialError}>
            {serialError}
          </span>
        ) : deviceInfo ? (
          <span className="hidden max-w-[300px] truncate text-[11px] text-muted-foreground min-[1100px]:inline">
            主槽 {deviceInfo.primary_version ? `v${deviceInfo.primary_version}` : "空"} · 副槽{" "}
            {deviceInfo.secondary_version ? `v${deviceInfo.secondary_version}` : "空"} · 计数{" "}
            {deviceInfo.security_counter ?? "—"}
          </span>
        ) : null}
      </div>
    </div>
  );
}
