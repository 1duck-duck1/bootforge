import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** 大小写不敏感的关键字高亮，搜索无结果时由调用方过滤 */
export function HighlightedText({
  text,
  query,
  className,
}: {
  text: string;
  query?: string;
  className?: string;
}) {
  const keyword = query?.trim() ?? "";
  if (!keyword) return <span className={className}>{text}</span>;

  const lowerText = text.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  while (cursor < text.length) {
    const found = lowerText.indexOf(lowerKeyword, cursor);
    if (found === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    if (found > cursor) parts.push(text.slice(cursor, found));
    parts.push(
      <mark
        key={key}
        className={cn("rounded-[2px] bg-yellow-300/70 px-px text-inherit dark:bg-yellow-500/40")}
      >
        {text.slice(found, found + keyword.length)}
      </mark>
    );
    key += 1;
    cursor = found + keyword.length;
  }

  return <span className={className}>{parts}</span>;
}
