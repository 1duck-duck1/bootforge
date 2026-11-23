import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Eraser, ScrollText } from "lucide-react";
import { useLogStore, type LogLevel } from "@/stores/logStore";
import { Button } from "@/components/ui/button";
import { cn, formatTimestamp } from "@/lib/utils";

const levelClass: Record<LogLevel, string> = {
  info: "text-foreground",
  success: "text-success",
  warn: "text-warning",
  error: "text-destructive",
};

export function LogPanel() {
  const entries = useLogStore((s) => s.entries);
  const clear = useLogStore((s) => s.clear);
  const [open, setOpen] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [entries, open]);

  return (
    <div className="surface-shell mx-2 mb-2 shrink-0 overflow-hidden rounded-xl">
      <div className="flex h-8 items-center gap-2 border-b px-2.5">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          <ScrollText className="h-3.5 w-3.5" />
          输出日志
          <span className="text-muted-foreground/60">({entries.length})</span>
        </button>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-6 px-1.5 text-[11px]"
          onClick={clear}
        >
          <Eraser className="h-3 w-3" />
          清空
        </Button>
      </div>
      {open && (
        <div ref={listRef} className="terminal-font max-h-28 overflow-y-auto px-3 py-1.5 text-[11px] leading-[1.6]">
          {entries.length === 0 ? (
            <span className="text-muted-foreground/60">暂无日志</span>
          ) : (
            entries.map((entry) => (
              <div key={entry.id} className="flex gap-2">
                <span className="shrink-0 select-none text-muted-foreground/50">
                  {formatTimestamp(entry.timestamp)}
                </span>
                <span className={cn("min-w-0 flex-1 break-all", levelClass[entry.level])}>
                  [{entry.level}] {entry.message}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
