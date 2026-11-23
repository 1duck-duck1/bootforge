import { useEffect } from "react";
import { CheckCircle2, Loader2, RefreshCw, Usb } from "lucide-react";
import { useOtaStore } from "@/stores/otaStore";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * 探针选择 / 连接 / 状态展示。
 * 探针会话在后端是全局唯一的，RTT 与烧录页面共用这里的状态。
 */
export function ProbeConnector({
  disabled = false,
  compact = false,
  onConnectedChange,
}: {
  disabled?: boolean;
  compact?: boolean;
  onConnectedChange?: (connected: boolean) => void;
}) {
  const probes = useOtaStore((s) => s.probes);
  const refreshingProbes = useOtaStore((s) => s.refreshingProbes);
  const selectedProbeId = useOtaStore((s) => s.selectedProbeId);
  const connecting = useOtaStore((s) => s.connecting);
  const connected = useOtaStore((s) => s.connected);
  const connectionInfo = useOtaStore((s) => s.connectionInfo);
  const refreshProbes = useOtaStore((s) => s.refreshProbes);
  const setSelectedProbe = useOtaStore((s) => s.setSelectedProbe);
  const connect = useOtaStore((s) => s.connect);
  const disconnect = useOtaStore((s) => s.disconnect);
  const checkConnection = useOtaStore((s) => s.checkConnection);

  // 页面挂载时同步后端连接状态；从未枚举过则先枚举探针
  useEffect(() => {
    void checkConnection();
    if (useOtaStore.getState().probes.length === 0) {
      void refreshProbes();
    }
  }, [checkConnection, refreshProbes]);

  useEffect(() => {
    onConnectedChange?.(connected);
  }, [connected, onConnectedChange]);

  const selectedProbe = probes.find((probe) => probe.probe_id === selectedProbeId) ?? null;

  return (
    <div className="flex flex-col gap-1.5">
      {!compact && (
        <div className="flex items-center gap-2">
          <Usb className="h-3.5 w-3.5 text-primary" />
          <span className="text-xs font-semibold">调试探针</span>
          <span className="text-[10.5px] text-muted-foreground">SWD · J-Link / ST-LINK</span>
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <Select
          value={selectedProbeId ?? ""}
          onChange={(event) => setSelectedProbe(event.target.value)}
          disabled={connected || connecting || disabled}
          className="h-8 min-w-0 flex-1 text-xs"
        >
          {probes.length === 0 && <option value="">（未发现探针）</option>}
          {probes.map((probe) => (
            <option key={probe.probe_id} value={probe.probe_id}>
              {probe.identifier}
            </option>
          ))}
        </Select>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={() => void refreshProbes()}
          disabled={refreshingProbes || connected || disabled}
          title="刷新探针列表"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", refreshingProbes && "animate-spin")} />
        </Button>
        {connected ? (
          <Button
            variant="outline"
            className="h-8 shrink-0 text-xs"
            onClick={() => void disconnect()}
            disabled={disabled}
          >
            断开
          </Button>
        ) : (
          <Button
            className="h-8 shrink-0 text-xs"
            onClick={() => void connect()}
            disabled={connecting || !selectedProbeId || disabled}
          >
            {connecting ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Usb className="mr-1 h-3 w-3" />
            )}
            连接
          </Button>
        )}
      </div>

      {selectedProbe?.connection_hint && !connected && (
        <p className="text-[10.5px] leading-snug text-yellow-600 dark:text-yellow-500">
          {selectedProbe.connection_hint}
        </p>
      )}

      <div className="flex items-center gap-1.5 text-[11px]">
        {connected ? (
          <>
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            <span className="truncate text-emerald-600 dark:text-emerald-400">
              {connectionInfo?.probe_name ?? "已连接"} · {connectionInfo?.target_name ?? "stm32f407vg"}
              {connectionInfo?.chip_id != null &&
                ` · 芯片ID 0x${(connectionInfo.chip_id >>> 0).toString(16).toUpperCase()}`}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">未连接（SWD · STM32F407VG）</span>
        )}
      </div>
    </div>
  );
}
