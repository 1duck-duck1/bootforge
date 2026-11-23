import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  AlertTriangle,
  CheckCircle2,
  FileCode2,
  FolderOpen,
  Loader2,
  RefreshCw,
  Zap,
} from "lucide-react";
import { useFlashStore, type FlashAddressMode } from "@/stores/flashStore";
import { useOtaStore } from "@/stores/otaStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useLogStore } from "@/stores/logStore";
import { SlotStatusPanel } from "@/components/ota/SlotStatusPanel";
import { LogPanel } from "@/components/log/LogPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatHex, parseHexNumber } from "@/lib/hex";
import { cn, formatBytes } from "@/lib/utils";

const PHASE_LABELS: Record<string, string> = {
  init: "准备",
  preverify: "预校验",
  erase: "擦除",
  program: "编程",
  verify: "校验",
  fill: "填充",
  finishing: "收尾",
  reset: "复位",
  complete: "完成",
  info: "信息",
};

function Section({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-primary">{icon}</span>
        <h2 className="text-sm font-semibold">{title}</h2>
        {hint && <span className="truncate text-[11px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

const ADDRESS_MODES: { value: FlashAddressMode; label: string }[] = [
  { value: "primary", label: "Primary 主槽" },
  { value: "secondary", label: "Secondary 副槽" },
  { value: "custom", label: "自定义地址" },
];

export function FlashMode() {
  const connected = useOtaStore((s) => s.connected);
  const firmwarePath = useFlashStore((s) => s.firmwarePath);
  const imageInfo = useFlashStore((s) => s.imageInfo);
  const inspecting = useFlashStore((s) => s.inspecting);
  const addressMode = useFlashStore((s) => s.addressMode);
  const customAddress = useFlashStore((s) => s.customAddress);
  const verify = useFlashStore((s) => s.verify);
  const reset = useFlashStore((s) => s.reset);
  const flashing = useFlashStore((s) => s.flashing);
  const progress = useFlashStore((s) => s.progress);
  const selectFirmware = useFlashStore((s) => s.selectFirmware);
  const inspect = useFlashStore((s) => s.inspect);
  const setFirmwarePath = useFlashStore((s) => s.setFirmwarePath);
  const setAddressMode = useFlashStore((s) => s.setAddressMode);
  const setCustomAddress = useFlashStore((s) => s.setCustomAddress);
  const setOptions = useFlashStore((s) => s.setOptions);
  const resolveAddress = useFlashStore((s) => s.resolveAddress);
  const flash = useFlashStore((s) => s.flash);
  const partition = useSettingsStore((s) => s.partition);

  const [isDragging, setIsDragging] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);

  // 拖入 .bin 直接作为烧录固件
  useEffect(() => {
    // 浏览器预览没有 Tauri 拖放接口
    if (!("__TAURI_INTERNALS__" in window)) return;
    const webview = getCurrentWebviewWindow();
    const unlisten = webview.onDragDropEvent((event) => {
      if (event.payload.type === "enter") {
        const paths = event.payload.paths ?? [];
        if (paths.some((path) => path.toLowerCase().endsWith(".bin"))) {
          setIsDragging(true);
        }
        return;
      }
      if (event.payload.type === "drop") {
        setIsDragging(false);
        const path = event.payload.paths.find((item) => item.toLowerCase().endsWith(".bin"));
        if (path) {
          setFirmwarePath(path);
          void inspect();
        } else if (event.payload.paths.length > 0) {
          useLogStore.getState().addLog("warn", "仅支持拖入 .bin 固件文件");
        }
        return;
      }
      if (event.payload.type === "leave") {
        setIsDragging(false);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [setFirmwarePath, inspect]);

  const address = resolveAddress();
  const percent = progress ? Math.round(progress.progress * 100) : 0;
  const phaseLabel = progress ? (PHASE_LABELS[progress.phase] ?? progress.phase) : null;
  const canFlash = connected && !!firmwarePath && address !== null && !flashing;

  const handleFlash = () => {
    if (addressMode === "custom" && parseHexNumber(customAddress) === null) {
      setAddressError("自定义地址格式无效，例如 0x08020000");
      return;
    }
    setAddressError(null);
    void flash();
  };

  // Flash 分区条：主槽 / 副槽 / Scratch
  const segments = [
    { label: "Primary 主槽", base: partition.primaryBase, size: partition.slotSize, color: "bg-primary" },
    { label: "Secondary 副槽", base: partition.secondaryBase, size: partition.slotSize, color: "bg-sky-500" },
    { label: "Scratch 交换区", base: partition.scratchBase, size: partition.scratchSize, color: "bg-amber-500" },
  ];

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* 工具条：选择固件 / 解析 / 进度 / 烧录 */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          onClick={() => void selectFirmware()}
          disabled={flashing}
        >
          <FolderOpen className="mr-1 h-3.5 w-3.5" />
          打开固件
        </Button>
        {firmwarePath && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            onClick={() => void inspect()}
            disabled={inspecting || flashing}
          >
            {inspecting ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
            )}
            解析
          </Button>
        )}

        <div className="ml-auto flex items-center gap-3">
          {progress && (
            <div className="flex items-center gap-2" title={progress.message}>
              <span
                className={cn(
                  "text-[11px] font-medium",
                  progress.phase === "complete"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-foreground"
                )}
              >
                {phaseLabel}
                {progress.phase !== "complete" && percent > 0 ? ` ${percent}%` : ""}
              </span>
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-200",
                    progress.phase === "complete" ? "bg-emerald-500" : "bg-primary"
                  )}
                  style={{ width: `${Math.max(2, percent)}%` }}
                />
              </div>
            </div>
          )}
          <Button size="sm" className="h-8 text-xs" onClick={handleFlash} disabled={!canFlash}>
            {flashing ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Zap className="mr-1 h-3.5 w-3.5" />
            )}
            {flashing ? "烧录中…" : "烧录"}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-3">
          {/* 固件：整行 */}
          <Section
            icon={<FileCode2 className="h-4 w-4" />}
            title="固件"
            hint={isDragging ? "松开以载入" : "拖放 .bin"}
          >
            <div
              className={cn(
                "flex flex-col gap-2 rounded-lg border border-dashed p-2.5 transition-colors",
                isDragging ? "border-primary bg-primary/10" : "border-border/80"
              )}
            >
              <div className="flex items-center gap-2">
                <p
                  className="terminal-font min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
                  title={firmwarePath}
                >
                  {firmwarePath || "尚未选择固件"}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 text-[11px]"
                  onClick={() => void selectFirmware()}
                  disabled={flashing}
                >
                  <FolderOpen className="mr-1 h-3 w-3" />
                  更换
                </Button>
              </div>

              {imageInfo && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px]">
                  {imageInfo.valid ? (
                    <>
                      <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="h-3 w-3" />
                        MCUboot
                      </span>
                      <span className="terminal-font">v{imageInfo.version ?? "—"}</span>
                      <span className="text-muted-foreground">
                        镜像 {formatBytes(imageInfo.image_size)}
                      </span>
                      {imageInfo.hash_match === false ? (
                        <span className="flex items-center gap-1 text-destructive">
                          <AlertTriangle className="h-3 w-3" />
                          哈希不匹配
                        </span>
                      ) : (
                        imageInfo.hash_match && (
                          <span className="text-muted-foreground">
                            {imageInfo.hash_algorithm} 校验通过
                          </span>
                        )
                      )}
                    </>
                  ) : (
                    <span className="flex items-center gap-1 text-yellow-600 dark:text-yellow-500">
                      <AlertTriangle className="h-3 w-3" />
                      普通 BIN
                    </span>
                  )}
                  <span className="ml-auto text-muted-foreground">
                    {formatBytes(imageInfo.file_size)}
                  </span>
                </div>
              )}
            </div>
          </Section>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {/* 烧录设置 */}
            <Section
              icon={<Zap className="h-4 w-4" />}
              title="烧录设置"
              hint={address !== null ? formatHex(address) : "地址无效"}
            >
              <div className="grid grid-cols-3 gap-1.5">
                {ADDRESS_MODES.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    onClick={() => setAddressMode(mode.value)}
                    disabled={flashing}
                    className={cn(
                      "rounded-lg border p-2 text-[11px] transition-colors",
                      addressMode === mode.value
                        ? "border-primary bg-primary/10 font-semibold text-primary"
                        : "border-border bg-card hover:bg-accent"
                    )}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>

              <div className="mt-2 grid grid-cols-2 gap-2 text-[10.5px]">
                <div className="rounded-lg bg-muted/40 px-2 py-1.5">
                  <p className="text-muted-foreground">起始地址</p>
                  <p className="terminal-font">{address !== null ? formatHex(address) : "—"}</p>
                </div>
                <div className="rounded-lg bg-muted/40 px-2 py-1.5">
                  <p className="text-muted-foreground">槽大小</p>
                  <p className="terminal-font">{formatBytes(partition.slotSize)}</p>
                </div>
              </div>

              {addressMode === "custom" && (
                <div className="mt-2">
                  <Input
                    value={customAddress}
                    onChange={(event) => {
                      setAddressError(null);
                      setCustomAddress(event.target.value);
                    }}
                    disabled={flashing}
                    placeholder="0x08020000"
                    className="terminal-font h-8 text-xs"
                    spellCheck={false}
                  />
                </div>
              )}

              <div className="mt-2 flex items-center gap-4 text-[11px]">
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={verify}
                    onChange={(event) => setOptions({ verify: event.target.checked })}
                    disabled={flashing}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  烧录后校验
                </label>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={reset}
                    onChange={(event) => setOptions({ reset: event.target.checked })}
                    disabled={flashing}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  烧录后复位
                </label>
              </div>

              {addressError && <p className="mt-2 text-[11px] text-destructive">{addressError}</p>}
            </Section>

            {/* Flash 分区 */}
            <Section icon={<Zap className="h-4 w-4" />} title="Flash 分区">
              <div className="flex flex-col gap-1.5">
                {segments.map((segment) => (
                  <div key={segment.label} className="flex items-center gap-2 text-[10.5px]">
                    <span className="w-28 shrink-0 text-muted-foreground">{segment.label}</span>
                    <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn("h-full rounded-full", segment.color)}
                        style={{
                          width: `${Math.max(
                            4,
                            Math.min(
                              100,
                              (segment.size / (partition.slotSize * 2 + partition.scratchSize)) * 100
                            )
                          )}%`,
                        }}
                      />
                    </div>
                    <span className="terminal-font w-24 shrink-0 text-right">{formatHex(segment.base)}</span>
                    <span className="w-14 shrink-0 text-right text-muted-foreground">
                      {formatBytes(segment.size)}
                    </span>
                  </div>
                ))}
              </div>
            </Section>

            <div className="lg:col-span-2">
              <SlotStatusPanel />
            </div>
          </div>
        </div>
      </div>

      <LogPanel />

      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-background/80 text-sm font-medium text-primary">
          松开以载入固件
        </div>
      )}
    </div>
  );
}
