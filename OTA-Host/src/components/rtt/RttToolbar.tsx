import { save } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownToLine,
  Binary,
  Clock,
  Download,
  Eraser,
  Pause,
  Play,
  Search,
  Square,
  Zap,
} from "lucide-react";
import { RTT_ALL_CHANNELS, useRttStore } from "@/stores/rttStore";
import { useOtaStore } from "@/stores/otaStore";
import { saveTextFile } from "@/lib/tauri";
import { useLogStore } from "@/stores/logStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { toHex } from "@/lib/hex";
import { cn, formatBytes } from "@/lib/utils";

function fullTimestamp(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function RttToolbar() {
  const running = useRttStore((s) => s.running);
  const attached = useRttStore((s) => s.attached);
  const starting = useRttStore((s) => s.starting);
  const config = useRttStore((s) => s.config);
  const lines = useRttStore((s) => s.lines);
  const bytesReceived = useRttStore((s) => s.bytesReceived);
  const bytesSent = useRttStore((s) => s.bytesSent);
  const selectedChannel = useRttStore((s) => s.selectedChannel);
  const setSelectedChannel = useRttStore((s) => s.setSelectedChannel);
  const showTimestamp = useRttStore((s) => s.showTimestamp);
  const setShowTimestamp = useRttStore((s) => s.setShowTimestamp);
  const hexView = useRttStore((s) => s.hexView);
  const setHexView = useRttStore((s) => s.setHexView);
  const autoScroll = useRttStore((s) => s.autoScroll);
  const setAutoScroll = useRttStore((s) => s.setAutoScroll);
  const paused = useRttStore((s) => s.paused);
  const setPaused = useRttStore((s) => s.setPaused);
  const search = useRttStore((s) => s.search);
  const setSearch = useRttStore((s) => s.setSearch);
  const clear = useRttStore((s) => s.clear);
  const start = useRttStore((s) => s.start);
  const stop = useRttStore((s) => s.stop);
  const connected = useOtaStore((s) => s.connected);

  const handleExport = async () => {
    if (lines.length === 0) return;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
      now.getHours()
    )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    const path = await save({
      title: "导出 RTT 日志",
      defaultPath: `rtt-log-${stamp}.txt`,
      filters: [
        { name: "文本", extensions: ["txt"] },
        { name: "日志", extensions: ["log"] },
      ],
    });
    if (typeof path !== "string") return;

    const content = [
      "# OTA-Host RTT 日志",
      `# 导出时间: ${now.toLocaleString()}`,
      `# 控制块: ${config ? `0x${config.control_block_address.toString(16).toUpperCase()}` : "-"}`,
      `# 行数: ${lines.length}`,
      ...lines.map(
        (line) =>
          `${fullTimestamp(line.timestamp)} [CH${line.channel}] [${line.direction.toUpperCase()}] ${
            hexView ? toHex(line.bytes) : line.text
          }`
      ),
    ].join("\n");

    try {
      await saveTextFile(path, content);
      useLogStore.getState().addLog("success", `RTT 日志已导出: ${path}（${lines.length} 行）`);
    } catch (error) {
      useLogStore.getState().addLog("error", `导出 RTT 日志失败: ${error}`);
    }
  };

  const channelOptions = config?.up_channels ?? [];

  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1.5 border-b px-2 py-1">
      <span className="flex items-center gap-1.5 pl-1 text-[11px]">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            running && attached
              ? "bg-success"
              : running
                ? "bg-yellow-500"
                : "bg-muted-foreground/50"
          )}
        />
        <span className="font-medium">
          {running ? (attached ? "RTT 运行中" : "正在重连…") : starting ? "正在扫描控制块…" : "RTT 未启动"}
        </span>
        {config && (
          <span className="terminal-font text-muted-foreground">
            0x{config.control_block_address.toString(16).toUpperCase()}
          </span>
        )}
      </span>

      <span className="text-[11px] text-muted-foreground">
        {lines.length} 行 · RX {formatBytes(bytesReceived)} · TX {formatBytes(bytesSent)}
        {paused && <span className="ml-2 text-yellow-600 dark:text-yellow-500">已暂停刷新</span>}
      </span>

      <div className="ml-auto flex flex-wrap items-center gap-1">
        <Select
          value={String(selectedChannel)}
          onChange={(event) => setSelectedChannel(Number(event.target.value))}
          className="h-7 w-32 text-[11px]"
          title="上行通道过滤"
        >
          <option value={RTT_ALL_CHANNELS}>全部通道</option>
          {channelOptions.map((channel) => (
            <option key={channel.index} value={channel.index}>
              通道 {channel.index}
              {channel.name ? ` · ${channel.name}` : ""}
            </option>
          ))}
        </Select>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索 RTT / HEX"
            className="h-7 w-40 pl-7 text-[11px]"
            spellCheck={false}
          />
        </div>

        <Tooltip label={paused ? "恢复显示" : "暂停显示"}>
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-7 w-7", paused && "text-yellow-600 dark:text-yellow-500")}
            onClick={() => setPaused(!paused)}
            aria-label="暂停显示"
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </Button>
        </Tooltip>
        <Tooltip label={showTimestamp ? "隐藏时间戳" : "显示时间戳"}>
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-7 w-7", showTimestamp && "text-primary")}
            onClick={() => setShowTimestamp(!showTimestamp)}
            aria-label="切换时间戳"
          >
            <Clock className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
        <Tooltip label={hexView ? "切换为文本显示" : "切换为 HEX 显示"}>
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-7 w-7", hexView && "text-primary")}
            onClick={() => setHexView(!hexView)}
            aria-label="切换十六进制显示"
          >
            <Binary className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
        <Tooltip label={autoScroll ? "跟随底部（点击暂停）" : "恢复跟随底部"}>
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-7 w-7", autoScroll && "text-primary")}
            onClick={() => setAutoScroll(!autoScroll)}
            aria-label="切换自动滚动"
          >
            <ArrowDownToLine className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
        <Tooltip label="导出完整 RTT 日志">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => void handleExport()}
            disabled={lines.length === 0}
            aria-label="导出日志"
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
        <Tooltip label="清空终端">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={clear} aria-label="清空终端">
            <Eraser className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>

        {running ? (
          <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => void stop()}>
            <Square className="mr-1 h-3 w-3" />
            停止
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => void start()}
            disabled={starting || !connected}
            title={connected ? "扫描并附着 RTT 控制块" : "请先连接调试探针"}
          >
            <Zap className="mr-1 h-3 w-3" />
            {starting ? "启动中…" : "启动 RTT"}
          </Button>
        )}
      </div>
    </div>
  );
}
