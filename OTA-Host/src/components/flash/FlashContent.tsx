import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  FileCode2,
  FolderOpen,
  HardDrive,
  Loader2,
  Settings,
  X,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SlotStatusPanel } from "@/components/ota/SlotStatusPanel";
import { useFlashStore, type FlashAddressMode } from "@/stores/flashStore";
import { useOtaStore } from "@/stores/otaStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { formatHex, parseHexNumber } from "@/lib/hex";
import { cn, formatBytes } from "@/lib/utils";

const ADDRESS_MODES: { value: FlashAddressMode; label: string }[] = [
  { value: "primary", label: "Primary 主槽" },
  { value: "secondary", label: "Secondary 副槽" },
  { value: "custom", label: "自定义地址" },
];

function InfoRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn("min-w-0 truncate text-right", mono && "terminal-font")}
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </span>
    </div>
  );
}

/** 烧录内容：固件卡片 + 目标芯片 / 烧录设置 / Flash 映射 / 烧录算法 / 设备槽位 */
export function FlashContent() {
  const firmwarePath = useFlashStore((s) => s.firmwarePath);
  const imageInfo = useFlashStore((s) => s.imageInfo);
  const inspecting = useFlashStore((s) => s.inspecting);
  const flashing = useFlashStore((s) => s.flashing);
  const progress = useFlashStore((s) => s.progress);
  const addressMode = useFlashStore((s) => s.addressMode);
  const customAddress = useFlashStore((s) => s.customAddress);
  const verify = useFlashStore((s) => s.verify);
  const reset = useFlashStore((s) => s.reset);
  const selectFirmware = useFlashStore((s) => s.selectFirmware);
  const clearFirmware = useFlashStore((s) => s.clearFirmware);
  const setAddressMode = useFlashStore((s) => s.setAddressMode);
  const setCustomAddress = useFlashStore((s) => s.setCustomAddress);
  const setOptions = useFlashStore((s) => s.setOptions);
  const resolveAddress = useFlashStore((s) => s.resolveAddress);

  const connected = useOtaStore((s) => s.connected);
  const connectionInfo = useOtaStore((s) => s.connectionInfo);
  const selectedChip = useOtaStore((s) => s.selectedChip);
  const chipInfo = useOtaStore((s) => s.chipInfo);
  const chipInfoError = useOtaStore((s) => s.chipInfoError);
  const partition = useSettingsStore((s) => s.partition);

  const address = resolveAddress();
  const percent = progress ? Math.round(progress.progress * 100) : 0;
  const firmwareFileName = firmwarePath?.split(/[\\/]/).pop();
  const customAddressValid = addressMode !== "custom" || parseHexNumber(customAddress) !== null;

  const flashRegions = chipInfo?.memory_regions.filter((region) => region.kind === "Flash") ?? [];
  const flashStart =
    flashRegions.length > 0 ? Math.min(...flashRegions.map((region) => region.address)) : null;
  const flashEnd =
    flashRegions.length > 0
      ? Math.max(...flashRegions.map((region) => region.address + region.size))
      : null;
  const otaEnd = Math.max(
    partition.secondaryBase + partition.slotSize,
    partition.scratchBase + partition.scratchSize
  );
  const otaOutOfRange = flashEnd !== null && otaEnd > flashEnd;
  const otaSegments = [
    ...(flashStart !== null && partition.primaryBase > flashStart
      ? [
          {
            name: "Bootloader 引导区",
            kind: "引导区",
            address: flashStart,
            size: partition.primaryBase - flashStart,
            badge: "bg-orange-500/20 text-orange-400",
          },
        ]
      : []),
    {
      name: "Primary 主槽",
      kind: "应用槽",
      address: partition.primaryBase,
      size: partition.slotSize,
      badge: "bg-blue-500/20 text-blue-400",
    },
    {
      name: "Secondary 副槽",
      kind: "应用槽",
      address: partition.secondaryBase,
      size: partition.slotSize,
      badge: "bg-blue-500/20 text-blue-400",
    },
    {
      name: "Scratch 交换区",
      kind: "交换区",
      address: partition.scratchBase,
      size: partition.scratchSize,
      badge: "bg-green-500/20 text-green-400",
    },
  ];

  return (
    <div className="flash-content h-full space-y-4 overflow-y-auto p-4">
      {/* 固件：烧录流程的起点，放在最上方并承载进度 */}
      <Card>
        <CardContent className="p-4">
          {firmwarePath ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="rounded-xl bg-primary/10 p-2.5 text-primary">
                  {flashing ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <FileCode2 className="h-5 w-5" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm font-medium" title={firmwarePath}>
                    {firmwareFileName}
                  </div>
                  <div className="truncate text-xs text-muted-foreground" title={firmwarePath}>
                    {imageInfo ? `${formatBytes(imageInfo.file_size)} · ` : ""}
                    {firmwarePath}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => void selectFirmware()}
                  disabled={flashing}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  更换固件
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={clearFirmware}
                  disabled={flashing}
                  title="移除固件"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              {inspecting && (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  正在解析镜像...
                </div>
              )}

              {imageInfo && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                  {imageInfo.valid ? (
                    <>
                      <span className="flex items-center gap-1 text-success">
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
                            {imageInfo.hash_algorithm ?? "哈希"} 校验通过
                          </span>
                        )
                      )}
                    </>
                  ) : (
                    <span className="flex items-center gap-1 text-warning">
                      <AlertTriangle className="h-3 w-3" />
                      普通 BIN（非 MCUboot 镜像）
                    </span>
                  )}
                  <span className="ml-auto text-muted-foreground">
                    {formatBytes(imageInfo.file_size)}
                  </span>
                </div>
              )}

              {flashing && (
                <div className="space-y-1.5">
                  <Progress
                    value={percent}
                    indicatorClassName={
                      progress?.phase === "complete"
                        ? "bg-success"
                        : progress?.phase === "error"
                          ? "bg-destructive"
                          : undefined
                    }
                  />
                  <div className="flex justify-between gap-3 text-xs text-muted-foreground">
                    <span className="truncate">{progress?.message ?? "准备烧录…"}</span>
                    <span className="shrink-0 font-medium text-primary">{percent}%</span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void selectFirmware()}
              className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-border py-8 text-center transition-colors hover:border-primary/60 hover:bg-primary/5"
            >
              <FolderOpen className="h-7 w-7 text-muted-foreground" />
              <span className="text-sm font-medium text-foreground">选择固件文件</span>
              <span className="text-xs text-muted-foreground">
                点击选择，或把 imgtool --pad 的 .bin 文件拖到窗口中
              </span>
            </button>
          )}
        </CardContent>
      </Card>

      <div className="flash-content-grid grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 目标芯片 */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Cpu className="h-4 w-4 text-primary" />
              目标芯片
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <InfoRow
                label="型号"
                value={
                  chipInfo?.name || selectedChip || (
                    <span className="text-muted-foreground">未选择</span>
                  )
                }
                mono
              />
              {chipInfo?.vendor && <InfoRow label="厂商" value={chipInfo.vendor} />}
              {chipInfo && chipInfo.cores.length > 0 && (
                <InfoRow
                  label="内核"
                  value={chipInfo.cores.map((core) => core.core_type).join(" / ")}
                />
              )}
              {connected && connectionInfo?.chip_id != null && (
                <InfoRow label="芯片ID" value={formatHex(connectionInfo.chip_id)} mono />
              )}
              <InfoRow
                label="状态"
                value={
                  connected ? (
                    <span className="text-success">已连接</span>
                  ) : (
                    <span className="text-muted-foreground">未连接</span>
                  )
                }
              />
            </div>
            {!chipInfo && (
              <p
                className={cn(
                  "mt-2 text-[11px]",
                  chipInfoError ? "text-destructive" : "text-muted-foreground"
                )}
              >
                {chipInfoError ?? (selectedChip ? "正在读取芯片信息…" : "在右侧检查器中搜索并选择目标芯片")}
              </p>
            )}
          </CardContent>
        </Card>

        {/* 烧录设置 */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Settings className="h-4 w-4 text-primary" />
              烧录设置
            </CardTitle>
          </CardHeader>
          <CardContent>
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
                  onChange={(event) => setCustomAddress(event.target.value)}
                  disabled={flashing}
                  placeholder="0x08020000"
                  className="terminal-font h-8 text-xs"
                  spellCheck={false}
                />
                {!customAddressValid && (
                  <p className="mt-1.5 text-[11px] text-destructive">地址格式无效，例如 0x08020000</p>
                )}
                {customAddressValid && address !== null && address < partition.primaryBase && (
                  <p className="mt-1.5 text-[11px] text-destructive">
                    该地址位于引导区，禁止烧录
                  </p>
                )}
              </div>
            )}

            {imageInfo && (
              <p
                className={cn(
                  "mt-2 text-[11px]",
                  addressMode !== "custom" && imageInfo.file_size > partition.slotSize
                    ? "text-destructive"
                    : "text-muted-foreground"
                )}
              >
                镜像 {formatBytes(imageInfo.file_size)} / 槽容量 {formatBytes(partition.slotSize)}
                {addressMode !== "custom" && imageInfo.file_size > partition.slotSize
                  ? " · 超出槽容量"
                  : ""}
              </p>
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
          </CardContent>
        </Card>

        {/* Flash 映射：来自所选芯片的 probe-rs 内存映射 */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <HardDrive className="h-4 w-4 text-primary" />
              Flash 映射
            </CardTitle>
          </CardHeader>
          <CardContent>
            {chipInfo && chipInfo.memory_regions.length > 0 ? (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="py-1 text-left font-medium">名称</th>
                    <th className="py-1 text-left font-medium">类型</th>
                    <th className="py-1 text-right font-medium">起始地址</th>
                    <th className="py-1 text-right font-medium">大小</th>
                  </tr>
                </thead>
                <tbody>
                  {chipInfo.memory_regions.map((region, index) => (
                    <tr
                      key={`${region.kind}-${region.address}-${index}`}
                      className="border-t border-border"
                    >
                      <td className="py-1">{region.name || `区域${index + 1}`}</td>
                      <td className="py-1">
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-xs",
                            region.kind === "Flash"
                              ? "bg-blue-500/20 text-blue-400"
                              : region.kind === "RAM"
                                ? "bg-green-500/20 text-green-400"
                                : "bg-slate-500/20 text-slate-400"
                          )}
                        >
                          {region.kind}
                        </span>
                      </td>
                      <td className="py-1 text-right font-mono">{formatHex(region.address)}</td>
                      <td className="py-1 text-right font-mono">{formatBytes(region.size)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="py-4 text-center text-sm text-muted-foreground">
                选择目标芯片后显示内存映射
              </div>
            )}

            <div className="mt-3 border-t border-border pt-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[11px] font-medium">OTA 分区</span>
                <span className="text-[10.5px] text-muted-foreground">与 sysflash 保持一致</span>
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="py-1 text-left font-medium">名称</th>
                    <th className="py-1 text-left font-medium">类型</th>
                    <th className="py-1 text-right font-medium">起始地址</th>
                    <th className="py-1 text-right font-medium">大小</th>
                  </tr>
                </thead>
                <tbody>
                  {otaSegments.map((segment) => (
                    <tr key={segment.name} className="border-t border-border">
                      <td className="py-1">{segment.name}</td>
                      <td className="py-1">
                        <span className={cn("rounded px-1.5 py-0.5 text-xs", segment.badge)}>
                          {segment.kind}
                        </span>
                      </td>
                      <td className="py-1 text-right font-mono">{formatHex(segment.address)}</td>
                      <td className="py-1 text-right font-mono">{formatBytes(segment.size)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {otaOutOfRange && (
                <p className="mt-1 text-[10.5px] text-destructive">
                  OTA 分区超出 {chipInfo?.name ?? "所选芯片"} 的 Flash 范围，请检查设置中心分区参数
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* 烧录算法：所选芯片内置的 probe-rs Flash 算法 */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Zap className="h-4 w-4 text-primary" />
              烧录算法
            </CardTitle>
          </CardHeader>
          <CardContent>
            {chipInfo && chipInfo.flash_algorithms.length > 0 ? (
              <div className="space-y-1.5">
                {chipInfo.flash_algorithms.map((algorithm) => (
                  <div
                    key={algorithm.name}
                    className="flex items-center gap-2 rounded-lg bg-muted/40 px-2 py-1.5 text-xs"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono" title={algorithm.name}>
                      {algorithm.name}
                    </span>
                    {algorithm.default && (
                      <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
                        默认
                      </span>
                    )}
                    <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                      {formatHex(algorithm.load_address)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-4 text-center text-sm text-muted-foreground">
                选择目标芯片后显示烧录算法
              </div>
            )}
          </CardContent>
        </Card>

        {/* 设备槽位（需探针，读取主/副槽 header 与 swap 状态） */}
        <div className="lg:col-span-2">
          <SlotStatusPanel />
        </div>
      </div>
    </div>
  );
}
