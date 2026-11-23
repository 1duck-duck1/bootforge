import { useEffect } from "react";
import { Radio } from "lucide-react";
import { useRttStore } from "@/stores/rttStore";
import { ProbeConnector } from "@/components/probe/ProbeConnector";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatHex, parseHexNumber } from "@/lib/hex";

/** RTT 侧栏：探针连接 + 启动参数 */
export function RttStartPanel() {
  const starting = useRttStore((s) => s.starting);
  const error = useRttStore((s) => s.error);
  const scanMode = useRttStore((s) => s.scanMode);
  const address = useRttStore((s) => s.address);
  const pollInterval = useRttStore((s) => s.pollInterval);
  const autoReattach = useRttStore((s) => s.autoReattach);
  const setStartOptions = useRttStore((s) => s.setStartOptions);

  // 切到精确模式时填入 SRAM 起始地址，便于快速修改
  useEffect(() => {
    if (scanMode === "exact" && !address) {
      setStartOptions({ address: formatHex(0x20000000) });
    }
  }, [scanMode, address, setStartOptions]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <ProbeConnector disabled={starting} />

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <Radio className="h-3.5 w-3.5 text-primary" />
          <h2 className="text-xs font-semibold">RTT 设置</h2>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[10.5px] text-muted-foreground">扫描模式</span>
          <Select
            value={scanMode}
            onChange={(event) =>
              setStartOptions({ scanMode: event.target.value as "auto" | "exact" })
            }
            disabled={starting}
            className="h-8 text-xs"
          >
            <option value="auto">自动扫描 RAM</option>
            <option value="exact">精确地址</option>
          </Select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10.5px] text-muted-foreground">控制块地址</span>
          <Input
            value={address}
            onChange={(event) => setStartOptions({ address: event.target.value })}
            disabled={scanMode !== "exact" || starting}
            placeholder="0x20000000"
            className="terminal-font h-8 text-xs"
            spellCheck={false}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10.5px] text-muted-foreground">轮询间隔 (ms)</span>
          <Input
            type="number"
            min={2}
            max={500}
            value={pollInterval}
            onChange={(event) =>
              setStartOptions({
                pollInterval: Math.min(500, Math.max(2, Number(event.target.value) || 10)),
              })
            }
            disabled={starting}
            className="h-8 text-xs"
          />
        </label>

        <label className="flex cursor-pointer items-center gap-1.5 pt-1 text-[11px]">
          <input
            type="checkbox"
            checked={autoReattach}
            onChange={(event) => setStartOptions({ autoReattach: event.target.checked })}
            disabled={starting}
            className="h-3.5 w-3.5 accent-primary"
          />
          复位后自动重新附着
        </label>

        {scanMode === "exact" && parseHexNumber(address) === null && (
          <p className="text-[10.5px] text-destructive">地址格式无效</p>
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-[11px] leading-relaxed text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
