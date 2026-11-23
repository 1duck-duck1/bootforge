import { useEffect, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, RotateCcw, Settings2, X } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useLogStore } from "@/stores/logStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatBytes } from "@/lib/utils";

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-[10.5px] text-muted-foreground/70">{hint}</span>}
    </label>
  );
}

/** 十六进制地址/大小输入，输入过程中允许不完整字符串 */
function HexField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(`0x${value.toString(16).toUpperCase()}`);
  useEffect(() => {
    setText(`0x${value.toString(16).toUpperCase()}`);
  }, [value]);

  return (
    <Field label={label} hint={hint}>
      <Input
        value={text}
        onChange={(event) => {
          const raw = event.target.value;
          setText(raw);
          const parsed = Number.parseInt(raw.replace(/^0x/i, ""), 16);
          if (Number.isFinite(parsed) && parsed >= 0) onChange(parsed);
        }}
        className="terminal-font text-xs"
        spellCheck={false}
      />
    </Field>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function SettingsDialog({ open: dialogOpen, onClose }: { open: boolean; onClose: () => void }) {
  const toolchain = useSettingsStore((s) => s.toolchain);
  const partition = useSettingsStore((s) => s.partition);
  const setToolchain = useSettingsStore((s) => s.setToolchain);
  const setPartition = useSettingsStore((s) => s.setPartition);
  const reset = useSettingsStore((s) => s.reset);

  useEffect(() => {
    if (!dialogOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dialogOpen, onClose]);

  if (!dialogOpen) return null;

  const pickFile = async (kind: "imgtool" | "key") => {
    const file = await open({
      title: kind === "imgtool" ? "选择 imgtool 脚本" : "选择签名私钥",
      filters:
        kind === "imgtool"
          ? [{ name: "Python 脚本", extensions: ["py"] }]
          : [{ name: "私钥", extensions: ["pem", "key"] }],
    });
    if (typeof file !== "string") return;
    if (kind === "imgtool") setToolchain({ imgtool: file });
    else setToolchain({ keyPath: file });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        className="surface-card flex max-h-[86vh] w-[640px] max-w-full flex-col overflow-hidden rounded-2xl bg-card"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <Settings2 className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">设置</h2>
          <span className="text-[11px] text-muted-foreground">修改即时生效并自动保存</span>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto h-8 w-8"
            onClick={onClose}
            aria-label="关闭设置"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5">
          <Section title="imgtool 工具链">
            <Field label="Python 命令" hint="PATH 中的 python 命令，或完整解释器路径">
              <Input
                value={toolchain.python}
                onChange={(event) => setToolchain({ python: event.target.value })}
                className="terminal-font text-xs"
                spellCheck={false}
              />
            </Field>
            <Field label="imgtool 脚本">
              <div className="flex gap-2">
                <Input
                  value={toolchain.imgtool}
                  onChange={(event) => setToolchain({ imgtool: event.target.value })}
                  className="terminal-font text-xs"
                  spellCheck={false}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0"
                  onClick={() => void pickFile("imgtool")}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </Button>
              </div>
            </Field>
            <Field label="签名私钥（PEM）">
              <div className="flex gap-2">
                <Input
                  value={toolchain.keyPath}
                  onChange={(event) => setToolchain({ keyPath: event.target.value })}
                  className="terminal-font text-xs"
                  spellCheck={false}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0"
                  onClick={() => void pickFile("key")}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </Button>
              </div>
            </Field>
          </Section>

          <Section title="Flash 分区（签名 / 烧录 / 槽位读取共用）">
            <div className="grid grid-cols-2 gap-3">
              <HexField
                label="Primary 基地址"
                value={partition.primaryBase}
                onChange={(primaryBase) => setPartition({ primaryBase })}
              />
              <HexField
                label="Secondary 基地址"
                value={partition.secondaryBase}
                onChange={(secondaryBase) => setPartition({ secondaryBase })}
              />
              <HexField
                label="槽大小"
                hint={`${formatBytes(partition.slotSize)}（imgtool --slot-size）`}
                value={partition.slotSize}
                onChange={(slotSize) => setPartition({ slotSize })}
              />
              <HexField
                label="Header 大小"
                hint={`${formatBytes(partition.headerSize)}（imgtool --header-size）`}
                value={partition.headerSize}
                onChange={(headerSize) => setPartition({ headerSize })}
              />
              <HexField
                label="Scratch 基地址"
                value={partition.scratchBase}
                onChange={(scratchBase) => setPartition({ scratchBase })}
              />
              <HexField
                label="Scratch 大小"
                hint={formatBytes(partition.scratchSize)}
                value={partition.scratchSize}
                onChange={(scratchSize) => setPartition({ scratchSize })}
              />
            </div>
            <Field label="对齐（字节）" hint="imgtool --align，Cortex-M 擦除粒度通常为 8">
              <Input
                type="number"
                min={1}
                value={partition.align}
                onChange={(event) => setPartition({ align: Number(event.target.value) || 1 })}
                className="terminal-font w-32 text-xs"
              />
            </Field>
          </Section>

          <p className="rounded-lg bg-muted/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
            分区参数必须与 Keil_OTA_Boot 的 sysflash 布局一致，否则签名槽大小、烧录地址与槽位状态读取都会错位。
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t px-4 py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              reset();
              useLogStore.getState().addLog("info", "设置已恢复默认值");
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            恢复默认
          </Button>
          <span className="text-[11px] text-muted-foreground">共 {partition.slotSize.toLocaleString()} 字节/槽</span>
          <Button className="ml-auto" size="sm" onClick={onClose}>
            完成
          </Button>
        </div>
      </div>
    </div>
  );
}
