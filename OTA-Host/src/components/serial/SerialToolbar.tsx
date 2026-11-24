import { useMemo } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownToLine,
  Binary,
  Clock,
  Columns2,
  Download,
  Eraser,
  Pause,
  Play,
  PlayCircle,
  Search,
  StopCircle,
} from "lucide-react";
import { useSerialStore } from "@/stores/serialStore";
import { DataViewSwitch } from "@/components/telemetry/DataViewSwitch";
import { saveTextFile } from "@/lib/tauri";
import { useLogStore } from "@/stores/logStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

export function SerialToolbar({
  query,
  onQueryChange,
}: {
  query: string;
  onQueryChange: (value: string) => void;
}) {
  const lines = useSerialStore((s) => s.lines);
  const autoScroll = useSerialStore((s) => s.autoScroll);
  const setAutoScroll = useSerialStore((s) => s.setAutoScroll);
  const paused = useSerialStore((s) => s.paused);
  const setPaused = useSerialStore((s) => s.setPaused);
  const splitView = useSerialStore((s) => s.splitView);
  const setSplitView = useSerialStore((s) => s.setSplitView);
  const clear = useSerialStore((s) => s.clear);
  const bytesReceived = useSerialStore((s) => s.bytesReceived);
  const bytesSent = useSerialStore((s) => s.bytesSent);
  const showTimestamp = useSerialStore((s) => s.form.showTimestamp);
  const hexView = useSerialStore((s) => s.form.hexView);
  const setForm = useSerialStore((s) => s.setForm);
  const port = useSerialStore((s) => s.form.port);
  const baudRate = useSerialStore((s) => s.form.baudRate);
  const connected = useSerialStore((s) => s.connected);
  const running = useSerialStore((s) => s.running);
  const startReceiving = useSerialStore((s) => s.startReceiving);
  const stopReceiving = useSerialStore((s) => s.stopReceiving);
  const viewMode = useSerialStore((s) => s.viewMode);
  const setViewMode = useSerialStore((s) => s.setViewMode);

  const matchCount = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return lines.length;
    const compactKeyword = keyword.replace(/\s+/g, "");
    return lines.filter(
      (line) =>
        line.text.toLowerCase().includes(keyword) ||
        toHex(line.bytes).toLowerCase().replace(/\s+/g, "").includes(compactKeyword)
    ).length;
  }, [lines, query]);

  const handleExport = async () => {
    if (lines.length === 0) return;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
      now.getHours()
    )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    const path = await save({
      title: "导出串口日志",
      defaultPath: `serial-log-${stamp}.txt`,
      filters: [
        { name: "文本", extensions: ["txt"] },
        { name: "日志", extensions: ["log"] },
      ],
    });
    if (typeof path !== "string") return;

    const content = [
      "# OTA-Host 串口日志",
      `# 导出时间: ${now.toLocaleString()}`,
      `# 端口: ${port || "-"} @ ${baudRate}`,
      `# 行数: ${lines.length}`,
      ...lines.map(
        (line) =>
          `${fullTimestamp(line.timestamp)} [${line.direction.toUpperCase()}] ${
            hexView ? toHex(line.bytes) : line.text
          }`
      ),
    ].join("\n");

    try {
      await saveTextFile(path, content);
      useLogStore.getState().addLog("success", `串口日志已导出: ${path}（${lines.length} 行）`);
    } catch (error) {
      useLogStore.getState().addLog("error", `导出串口日志失败: ${error}`);
    }
  };

  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1">
      <span className="mr-auto pl-1 text-[11px] text-muted-foreground">
        {lines.length} 行 · RX {formatBytes(bytesReceived)} · TX {formatBytes(bytesSent)}
        {query.trim() && ` · 匹配 ${matchCount}/${lines.length}`}
        {paused && <span className="ml-2 text-yellow-600 dark:text-yellow-500">已暂停刷新</span>}
        {connected && !running && (
          <span className="ml-2 text-yellow-600 dark:text-yellow-500">接收已停止</span>
        )}
      </span>

      <DataViewSwitch value={viewMode} onChange={setViewMode} />

      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索日志 / HEX"
          className="h-7 w-44 pl-7 text-[11px]"
          spellCheck={false}
        />
      </div>

      {connected && (
        <Tooltip label={running ? "停止接收（串口保持连接）" : "恢复接收"}>
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-7 w-7", !running && "text-yellow-600 dark:text-yellow-500")}
            onClick={() => void (running ? stopReceiving() : startReceiving())}
            aria-label={running ? "停止接收" : "恢复接收"}
          >
            {running ? <StopCircle className="h-3.5 w-3.5" /> : <PlayCircle className="h-3.5 w-3.5" />}
          </Button>
        </Tooltip>
      )}
      <Tooltip label={paused ? "恢复显示（补上暂停期间日志）" : "暂停显示"}>
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
          onClick={() => setForm({ showTimestamp: !showTimestamp })}
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
          onClick={() => setForm({ hexView: !hexView })}
          aria-label="切换十六进制显示"
        >
          <Binary className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
      <Tooltip label={splitView ? "合并 RX/TX 分栏" : "按 RX/TX 分栏显示"}>
        <Button
          variant="ghost"
          size="icon"
          className={cn("h-7 w-7", splitView && "text-primary")}
          onClick={() => setSplitView(!splitView)}
          aria-label="切换收发分栏"
        >
          <Columns2 className="h-3.5 w-3.5" />
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
      <Tooltip label="导出完整日志">
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
    </div>
  );
}
