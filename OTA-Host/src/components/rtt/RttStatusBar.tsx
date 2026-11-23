import { useRttStore } from "@/stores/rttStore";
import { cn, formatBytes } from "@/lib/utils";

/** RTT 底部状态栏：附着信息 + 通道 + 统计 */
export function RttStatusBar() {
  const running = useRttStore((s) => s.running);
  const attached = useRttStore((s) => s.attached);
  const starting = useRttStore((s) => s.starting);
  const config = useRttStore((s) => s.config);
  const lines = useRttStore((s) => s.lines);
  const bytesReceived = useRttStore((s) => s.bytesReceived);
  const bytesSent = useRttStore((s) => s.bytesSent);
  const pollInterval = useRttStore((s) => s.pollInterval);
  const autoReattach = useRttStore((s) => s.autoReattach);
  const error = useRttStore((s) => s.error);

  const statusText = starting
    ? "扫描控制块中"
    : running
      ? attached
        ? "已附着"
        : "重连中"
      : "未运行";

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-t bg-muted/30 px-3 py-1 text-[10.5px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            running && attached
              ? "bg-success"
              : running || starting
                ? "bg-yellow-500"
                : "bg-muted-foreground/50"
          )}
        />
        {statusText}
      </span>

      {config && (
        <span className="terminal-font">
          控制块 0x{config.control_block_address.toString(16).toUpperCase()} · 上行{" "}
          {config.up_channels.length} · 下行 {config.down_channels.length}
        </span>
      )}

      <span>轮询 {pollInterval} ms</span>
      {autoReattach && <span>自动重连</span>}
      <span>{lines.length} 行</span>
      <span>RX {formatBytes(bytesReceived)}</span>
      <span>TX {formatBytes(bytesSent)}</span>

      {error && (
        <span className={cn("truncate", running ? "text-yellow-600 dark:text-yellow-500" : "text-destructive")}>
          {error}
        </span>
      )}
    </div>
  );
}
