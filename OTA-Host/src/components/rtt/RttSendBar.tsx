import { useState, type KeyboardEvent } from "react";
import { Binary, Send } from "lucide-react";
import { useRttStore, type RttLineEnding } from "@/stores/rttStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { parseHexBytes } from "@/lib/hex";
import { cn } from "@/lib/utils";

const LINE_ENDINGS: { value: RttLineEnding; label: string }[] = [
  { value: "none", label: "无换行" },
  { value: "lf", label: "LF (\\n)" },
  { value: "crlf", label: "CRLF (\\r\\n)" },
  { value: "cr", label: "CR (\\r)" },
];

export function RttSendBar() {
  const running = useRttStore((s) => s.running);
  const config = useRttStore((s) => s.config);
  const send = useRttStore((s) => s.send);

  const [downChannel, setDownChannel] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [lineEnding, setLineEnding] = useState<RttLineEnding>("lf");
  const [hexMode, setHexMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const downChannels = config?.down_channels ?? [];
  const writable = running && downChannels.length > 0;
  const activeDown =
    downChannel !== null && downChannels.some((channel) => channel.index === downChannel)
      ? downChannel
      : (downChannels[0]?.index ?? 0);

  const doSend = async (value: string) => {
    if (!value) return;
    setError(null);

    if (hexMode) {
      const bytes = parseHexBytes(value);
      if (bytes === null) {
        setError("HEX 格式错误：需要偶数个十六进制字符，例如 AA 55 01");
        return;
      }
      if (bytes.length === 0) return;
    }

    await send(value, lineEnding, hexMode, activeDown);
    setHistory((previous) => [...previous.filter((item) => item !== value).slice(-19), value]);
    setHistoryIndex(-1);
    setText("");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void doSend(text);
      return;
    }
    if (event.key === "ArrowUp" && history.length > 0) {
      event.preventDefault();
      const index = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(index);
      setText(history[index]);
      return;
    }
    if (event.key === "ArrowDown" && historyIndex >= 0) {
      event.preventDefault();
      const index = historyIndex + 1;
      if (index >= history.length) {
        setHistoryIndex(-1);
        setText("");
      } else {
        setHistoryIndex(index);
        setText(history[index]);
      }
    }
  };

  const placeholder = !running
    ? "RTT 未启动"
    : downChannels.length === 0
      ? "固件没有提供 RTT 下行通道"
      : hexMode
        ? "HEX 发送，例如 AA 55 01（↑/↓ 历史）"
        : "向下行通道发送数据，回车发送（↑/↓ 历史）";

  return (
    <div className="flex shrink-0 flex-col gap-1 border-t px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={String(activeDown)}
          onChange={(event) => setDownChannel(Number(event.target.value))}
          disabled={!writable || downChannels.length <= 1}
          className="h-9 w-28 text-xs"
          title="发送目标下行通道"
        >
          {downChannels.length === 0 && <option value="0">无下行通道</option>}
          {downChannels.map((channel) => (
            <option key={channel.index} value={channel.index}>
              下行 {channel.index}
              {channel.name ? ` · ${channel.name}` : ""}
            </option>
          ))}
        </Select>

        <Input
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
          onKeyDown={handleKeyDown}
          disabled={!writable}
          placeholder={placeholder}
          className="terminal-font h-9 min-w-40 flex-1"
          spellCheck={false}
        />

        <Select
          value={lineEnding}
          onChange={(event) => setLineEnding(event.target.value as RttLineEnding)}
          disabled={!writable || hexMode}
          className="h-9 w-28 text-xs"
          title="文本发送的行尾"
        >
          {LINE_ENDINGS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </Select>

        <Tooltip label={hexMode ? "切换为文本发送" : "切换为 HEX 发送"}>
          <Button
            size="sm"
            variant={hexMode ? "default" : "outline"}
            className={cn("h-9", hexMode && "gap-1")}
            onClick={() => {
              setHexMode(!hexMode);
              setError(null);
            }}
            disabled={!writable}
          >
            <Binary className="h-3.5 w-3.5" />
            HEX
          </Button>
        </Tooltip>

        <Button
          size="sm"
          className="h-9"
          disabled={!writable || !text}
          onClick={() => void doSend(text)}
        >
          <Send className="h-3.5 w-3.5" />
          发送
        </Button>
      </div>

      {downChannels.length > 0 && (
        <p className="text-[10.5px] text-muted-foreground">
          下行通道：
          {downChannels.map((channel) => channel.name ?? `#${channel.index}`).join(" / ")}
        </p>
      )}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
