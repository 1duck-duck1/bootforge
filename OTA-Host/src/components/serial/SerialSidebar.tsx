import { useEffect } from "react";
import { Plug, PlugZap, RefreshCw } from "lucide-react";
import { useSerialStore } from "@/stores/serialStore";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export function SerialSidebar() {
  const ports = useSerialStore((s) => s.ports);
  const form = useSerialStore((s) => s.form);
  const setForm = useSerialStore((s) => s.setForm);
  const refreshPorts = useSerialStore((s) => s.refreshPorts);
  const connect = useSerialStore((s) => s.connect);
  const disconnect = useSerialStore((s) => s.disconnect);
  const connected = useSerialStore((s) => s.connected);
  const error = useSerialStore((s) => s.error);
  const bytesReceived = useSerialStore((s) => s.bytesReceived);
  const flowLabel =
    form.flowControl === "none" ? "无流控" : form.flowControl === "hardware" ? "硬件流控" : "软件流控";

  // 端口热插拔：未连接时每 2s 轻量刷新一次枚举结果
  useEffect(() => {
    void refreshPorts();
    const timer = window.setInterval(() => {
      if (!useSerialStore.getState().connected) void refreshPorts();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refreshPorts]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">串口连接</h2>
        <Tooltip label="重新枚举串口">
          <Button variant="ghost" size="icon" className="ml-auto h-7 w-7" onClick={() => void refreshPorts()}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
      </div>

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">端口</span>
        <Select
          value={form.port}
          onChange={(e) => setForm({ port: e.target.value })}
          disabled={connected}
        >
          {ports.length === 0 && <option value="">（未检测到串口）</option>}
          {ports.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
              {p.description ? ` - ${p.description}` : ""}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">波特率</span>
        <Select
          value={String(form.baudRate)}
          onChange={(e) => setForm({ baudRate: Number(e.target.value) })}
          disabled={connected}
        >
          {BAUD_RATES.map((rate) => (
            <option key={rate} value={rate}>
              {rate}
            </option>
          ))}
        </Select>
      </label>

      <details className="rounded-lg border bg-muted/30 p-2.5 text-xs">
        <summary className="cursor-pointer select-none text-muted-foreground">
          高级参数（{form.dataBits}
          {form.parity === "none" ? "N" : form.parity === "even" ? "E" : "O"}
          {form.stopBits} · {flowLabel}）
        </summary>
        <div className="mt-2.5 grid grid-cols-2 gap-2.5">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">数据位</span>
            <Select
              value={String(form.dataBits)}
              onChange={(e) => setForm({ dataBits: Number(e.target.value) })}
              disabled={connected}
              className="h-8 text-xs"
            >
              {[5, 6, 7, 8].map((bits) => (
                <option key={bits} value={bits}>
                  {bits}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">停止位</span>
            <Select
              value={String(form.stopBits)}
              onChange={(e) => setForm({ stopBits: Number(e.target.value) })}
              disabled={connected}
              className="h-8 text-xs"
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">校验</span>
            <Select
              value={form.parity}
              onChange={(e) => setForm({ parity: e.target.value as typeof form.parity })}
              disabled={connected}
              className="h-8 text-xs"
            >
              <option value="none">无校验</option>
              <option value="even">偶校验</option>
              <option value="odd">奇校验</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">流控</span>
            <Select
              value={form.flowControl}
              onChange={(e) => setForm({ flowControl: e.target.value as typeof form.flowControl })}
              disabled={connected}
              className="h-8 text-xs"
            >
              <option value="none">无</option>
              <option value="hardware">硬件 RTS/CTS</option>
              <option value="software">软件 XON/XOFF</option>
            </Select>
          </label>
        </div>
        <div className="mt-2 flex items-center gap-4 text-[11px]">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={form.dtr}
              onChange={(e) => setForm({ dtr: e.target.checked })}
              disabled={connected}
              className="h-3.5 w-3.5 accent-primary"
            />
            DTR
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={form.rts}
              onChange={(e) => setForm({ rts: e.target.checked })}
              disabled={connected || form.flowControl === "hardware"}
              className="h-3.5 w-3.5 accent-primary"
            />
            RTS
          </label>
          <span className="ml-auto text-muted-foreground/70">改动在下次连接时生效</span>
        </div>
      </details>

      {connected ? (
        <Button variant="destructive" onClick={() => void disconnect()}>
          <PlugZap className="h-4 w-4" />
          断开
        </Button>
      ) : (
        <Button onClick={() => void connect()} disabled={!form.port}>
          <Plug className="h-4 w-4" />
          连接
        </Button>
      )}

      {error && (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
          {error}
        </p>
      )}

      <div className="mt-auto rounded-lg bg-muted/60 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
        <p className="mb-1 font-semibold text-foreground">小贴士</p>
        <p>boot 日志波特率 115200（USART2 / PA2）。日志疑似缺失时先确认设备管理器里的 COM 号。</p>
        <p className="mt-1">已接收 {bytesReceived} 字节。</p>
      </div>
    </div>
  );
}
