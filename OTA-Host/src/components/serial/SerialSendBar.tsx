import { useState, type KeyboardEvent } from "react";
import { Binary, Send } from "lucide-react";
import { useSerialStore, type LineEnding } from "@/stores/serialStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { parseHexBytes } from "@/lib/hex";
import { cn } from "@/lib/utils";

/** OTA 快捷命令（Keil_App 单字符命令协议） */
const QUICK_COMMANDS: { key: string; label: string; hint: string; variant: "default" | "secondary" }[] = [
  { key: "p", label: "p · 标记升级", hint: "boot_set_pending + 复位重启，重启后 MCUboot 执行 swap", variant: "default" },
  { key: "s", label: "s · 查询状态", hint: "boot_swap_type()：查询当前槽交换状态", variant: "secondary" },
];

const LINE_ENDINGS: { value: LineEnding; label: string }[] = [
  { value: "none", label: "无换行" },
  { value: "lf", label: "LF (\\n)" },
  { value: "crlf", label: "CRLF (\\r\\n)" },
  { value: "cr", label: "CR (\\r)" },
];

export function SerialSendBar() {
  const connected = useSerialStore((s) => s.connected);
  const send = useSerialStore((s) => s.send);
  const sendBytes = useSerialStore((s) => s.sendBytes);
  const lineEnding = useSerialStore((s) => s.form.lineEnding);
  const setForm = useSerialStore((s) => s.setForm);

  const [text, setText] = useState("");
  const [hexMode, setHexMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

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
      await sendBytes(bytes);
    } else {
      await send(value, lineEnding);
    }

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

  const placeholder = !connected
    ? "请先连接串口"
    : hexMode
      ? "HEX 发送，例如 AA 55 01（↑/↓ 历史）"
      : "输入要发送的内容，回车发送（↑/↓ 历史）";

  return (
    <div className="flex shrink-0 flex-col gap-1 border-t px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={handleKeyDown}
          disabled={!connected}
          placeholder={placeholder}
          className="terminal-font h-9 min-w-40 flex-1"
          spellCheck={false}
        />

        <Select
          value={lineEnding}
          onChange={(e) => setForm({ lineEnding: e.target.value as LineEnding })}
          disabled={!connected || hexMode}
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
          >
            <Binary className="h-3.5 w-3.5" />
            HEX
          </Button>
        </Tooltip>

        <Button size="sm" className="h-9" disabled={!connected || !text} onClick={() => void doSend(text)}>
          <Send className="h-3.5 w-3.5" />
          发送
        </Button>

        <div className="flex items-center gap-1.5">
          {QUICK_COMMANDS.map((cmd) => (
            <Tooltip key={cmd.key} label={cmd.hint}>
              <Button
                size="sm"
                variant={cmd.variant}
                className="h-9"
                disabled={!connected}
                onClick={() => void send(cmd.key, "none")}
              >
                {cmd.label}
              </Button>
            </Tooltip>
          ))}
        </div>
      </div>

      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
