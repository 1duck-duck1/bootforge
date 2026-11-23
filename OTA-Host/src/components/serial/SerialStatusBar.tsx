import { useSerialStore } from "@/stores/serialStore";
import { cn, formatBytes } from "@/lib/utils";

/** 串口终端底部状态栏：连接参数 + 收发统计 */
export function SerialStatusBar() {
  const connected = useSerialStore((s) => s.connected);
  const running = useSerialStore((s) => s.running);
  const error = useSerialStore((s) => s.error);
  const form = useSerialStore((s) => s.form);
  const bytesReceived = useSerialStore((s) => s.bytesReceived);
  const bytesSent = useSerialStore((s) => s.bytesSent);

  const statusText = !connected ? "未连接" : running ? "接收中" : "已停止接收";

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-t bg-muted/30 px-3 py-1 text-[10.5px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            connected ? (running ? "bg-success" : "bg-yellow-500") : "bg-muted-foreground/50"
          )}
        />
        {statusText}
      </span>
      <span className="terminal-font">
        {form.port || "—"} @ {form.baudRate} · {form.dataBits}
        {form.parity === "none" ? "N" : form.parity === "odd" ? "O" : "E"}
        {form.stopBits}
        {form.flowControl !== "none" && ` · ${form.flowControl === "hardware" ? "RTS/CTS" : "XON/XOFF"}`}
      </span>
      <span>RX {formatBytes(bytesReceived)}</span>
      <span>TX {formatBytes(bytesSent)}</span>
      {(form.dtr || form.rts) && (
        <span>
          {form.dtr && "DTR"}{form.dtr && form.rts && " · "}{form.rts && "RTS"}
        </span>
      )}
      {error && <span className="ml-auto truncate text-destructive">{error}</span>}
    </div>
  );
}
