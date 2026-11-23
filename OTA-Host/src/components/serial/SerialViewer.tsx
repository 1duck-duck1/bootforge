import { useEffect, useMemo, useRef } from "react";
import { useSerialStore } from "@/stores/serialStore";
import { HighlightedText } from "@/components/common/HighlightedText";
import { toHex } from "@/lib/hex";
import { cn, formatTimestamp } from "@/lib/utils";

/**
 * 串口终端视图。
 * direction 为空时显示 RX+TX；传入 rx/tx 时只显示对应方向（收发分屏）。
 */
export function SerialViewer({
  query = "",
  direction,
  label,
}: {
  query?: string;
  direction?: "rx" | "tx";
  label?: string;
}) {
  const lines = useSerialStore((s) => s.lines);
  const autoScroll = useSerialStore((s) => s.autoScroll);
  const setAutoScroll = useSerialStore((s) => s.setAutoScroll);
  const showTimestamp = useSerialStore((s) => s.form.showTimestamp);
  const hexView = useSerialStore((s) => s.form.hexView);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const visibleLines = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const compactKeyword = keyword.replace(/\s+/g, "");
    return lines.filter((line) => {
      if (direction && line.direction !== direction) return false;
      if (!keyword) return true;
      if (line.text.toLowerCase().includes(keyword)) return true;
      // HEX 搜索忽略空格：AA BB 也能用 AABB 命中
      return toHex(line.bytes).toLowerCase().replace(/\s+/g, "").includes(compactKeyword);
    });
  }, [lines, query, direction]);

  // 用户手动滚动时取消跟随；回到接近底部时恢复
  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    stickToBottomRef.current = atBottom;
    if (atBottom !== autoScroll) setAutoScroll(atBottom);
  };

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [visibleLines, autoScroll]);

  const emptyText = query.trim()
    ? `没有匹配「${query}」的日志`
    : direction === "rx"
      ? "暂无接收数据"
      : direction === "tx"
        ? "暂无发送数据"
        : "连接串口后显示日志";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {label && (
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1 text-[10.5px] text-muted-foreground">
          <span className="font-medium">{label}</span>
          <span className="ml-auto">{visibleLines.length} 行</span>
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="terminal-font min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[12.5px] leading-[1.7]"
      >
        {visibleLines.length === 0 ? (
          <p className="select-none pt-8 text-center text-xs text-muted-foreground/70">{emptyText}</p>
        ) : (
          visibleLines.map((line) => (
            <div key={line.id} className="flex gap-2 whitespace-pre-wrap break-all">
              {showTimestamp && (
                <span className="shrink-0 select-none text-muted-foreground/60">
                  {formatTimestamp(line.timestamp)}
                </span>
              )}
              <span
                className={cn(
                  "min-w-0 flex-1",
                  line.direction === "tx"
                    ? "text-[rgb(var(--terminal-tx))]"
                    : "text-[rgb(var(--terminal-rx))]"
                )}
              >
                {line.direction === "tx" ? "» " : ""}
                <HighlightedText text={hexView ? toHex(line.bytes) : line.text} query={query} />
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
