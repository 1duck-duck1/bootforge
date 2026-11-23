import { useEffect, useMemo, useRef } from "react";
import { RTT_ALL_CHANNELS, useRttStore } from "@/stores/rttStore";
import { HighlightedText } from "@/components/common/HighlightedText";
import { toHex } from "@/lib/hex";
import { cn, formatTimestamp } from "@/lib/utils";

const CHANNEL_COLORS = [
  "border-primary/40 text-primary",
  "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  "border-amber-500/40 text-amber-600 dark:text-amber-400",
  "border-sky-500/40 text-sky-600 dark:text-sky-400",
  "border-fuchsia-500/40 text-fuchsia-600 dark:text-fuchsia-400",
];

function channelColor(channel: number): string {
  return CHANNEL_COLORS[channel % CHANNEL_COLORS.length];
}

export function RttViewer() {
  const lines = useRttStore((s) => s.lines);
  const running = useRttStore((s) => s.running);
  const attached = useRttStore((s) => s.attached);
  const selectedChannel = useRttStore((s) => s.selectedChannel);
  const showTimestamp = useRttStore((s) => s.showTimestamp);
  const hexView = useRttStore((s) => s.hexView);
  const autoScroll = useRttStore((s) => s.autoScroll);
  const setAutoScroll = useRttStore((s) => s.setAutoScroll);
  const search = useRttStore((s) => s.search);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visibleLines = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const compactKeyword = keyword.replace(/\s+/g, "");
    return lines.filter((line) => {
      if (selectedChannel !== RTT_ALL_CHANNELS && line.channel !== selectedChannel) return false;
      if (!keyword) return true;
      if (line.text.toLowerCase().includes(keyword)) return true;
      return toHex(line.bytes).toLowerCase().replace(/\s+/g, "").includes(compactKeyword);
    });
  }, [lines, search, selectedChannel]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    if (atBottom !== autoScroll) setAutoScroll(atBottom);
  };

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [visibleLines, autoScroll]);

  const emptyText = search.trim()
    ? `没有匹配「${search}」的 RTT 输出`
    : !running
      ? "启动 RTT 后显示目标输出"
      : !attached
        ? "正在重新扫描 RTT 控制块…"
        : selectedChannel !== RTT_ALL_CHANNELS
          ? `通道 ${selectedChannel} 暂无输出`
          : "已附着，等待目标输出…";

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="terminal-font min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[12.5px] leading-[1.7]"
    >
      {visibleLines.length === 0 ? (
        <p className="select-none pt-8 text-center text-xs text-muted-foreground/70">{emptyText}</p>
      ) : (
        visibleLines.map((line) => (
          <div key={line.id} className="flex items-start gap-2 whitespace-pre-wrap break-all">
            {showTimestamp && (
              <span className="shrink-0 select-none text-muted-foreground/60">
                {formatTimestamp(line.timestamp)}
              </span>
            )}
            <span
              className={cn(
                "shrink-0 select-none rounded border px-1 text-[9.5px] leading-4",
                channelColor(line.channel)
              )}
            >
              CH{line.channel}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1",
                line.direction === "tx"
                  ? "text-[rgb(var(--terminal-tx))]"
                  : "text-[rgb(var(--terminal-rx))]"
              )}
            >
              {line.direction === "tx" ? "» " : ""}
              <HighlightedText text={hexView ? toHex(line.bytes) : line.text} query={search} />
            </span>
          </div>
        ))
      )}
    </div>
  );
}
