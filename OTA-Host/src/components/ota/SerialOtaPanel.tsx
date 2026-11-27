import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Cpu,
  FileCode2,
  FolderOpen,
  Loader2,
  MinusCircle,
  PenLine,
  RefreshCw,
  Rocket,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import { useOtaStore } from "@/stores/otaStore";
import { useSerialStore } from "@/stores/serialStore";
import { useSerialOtaStore } from "@/stores/serialOtaStore";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatBytes } from "@/lib/utils";
import { OTA_STEPS, PHASE_LABELS } from "./phaseLabels";
import { SignPanel } from "./SignPanel";
import { SlotStatusPanel } from "./SlotStatusPanel";

const PHASE_STEP: Record<string, number> = {
  connecting: 0,
  enter: 1,
  query: 2,
  start: 3,
  data: 4,
  end: 5,
  apply: 6,
  verify: 7,
};

type PreflightState = "ok" | "warn" | "info";

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function parseVersion(text: string): [number, number, number] | null {
  const parts = text.trim().split(".");
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((num) => !Number.isInteger(num) || num < 0)) return null;
  return [nums[0], nums[1] ?? 0, nums[2] ?? 0];
}

function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function PreflightRow({
  state,
  label,
  detail,
}: {
  state: PreflightState;
  label: string;
  detail: string;
}) {
  const Icon = state === "ok" ? CheckCircle2 : state === "warn" ? AlertTriangle : MinusCircle;
  return (
    <div className="flex min-w-0 items-start gap-1">
      <Icon
        className={cn(
          "mt-0.5 h-3 w-3 shrink-0",
          state === "ok"
            ? "text-success"
            : state === "warn"
              ? "text-warning"
              : "text-muted-foreground/50"
        )}
      />
      <div className="min-w-0 leading-tight">
        <p className="text-[10.5px] text-foreground">{label}</p>
        <p className="truncate text-[10px] text-muted-foreground" title={detail}>
          {detail}
        </p>
      </div>
    </div>
  );
}

export function SerialOtaPanel() {
  const form = useOtaStore((s) => s.form);
  const signResult = useOtaStore((s) => s.result);
  const imageInfo = useOtaStore((s) => s.imageInfo);
  const inspect = useOtaStore((s) => s.inspect);

  const serialForm = useSerialStore((s) => s.form);
  const connected = useSerialStore((s) => s.connected);

  const running = useSerialOtaStore((s) => s.running);
  const phase = useSerialOtaStore((s) => s.phase);
  const progress = useSerialOtaStore((s) => s.progress);
  const sent = useSerialOtaStore((s) => s.sent);
  const total = useSerialOtaStore((s) => s.total);
  const logs = useSerialOtaStore((s) => s.logs);
  const error = useSerialOtaStore((s) => s.error);
  const otaResult = useSerialOtaStore((s) => s.result);
  const deviceInfo = useSerialOtaStore((s) => s.deviceInfo);
  const readingDevice = useSerialOtaStore((s) => s.readingDevice);
  const readDeviceInfo = useSerialOtaStore((s) => s.readDeviceInfo);
  const manualPath = useSerialOtaStore((s) => s.imagePath);
  const setImagePath = useSerialOtaStore((s) => s.setImagePath);
  const start = useSerialOtaStore((s) => s.start);
  const cancel = useSerialOtaStore((s) => s.cancel);

  const [logsOpen, setLogsOpen] = useState(true);
  const [versionGuard, setVersionGuard] = useState(true);
  const [copied, setCopied] = useState<"result" | "logs" | null>(null);
  const copyTimer = useRef<number | null>(null);

  const binPath = manualPath ?? signResult?.output_path ?? form.outputPath;
  const percent = Math.round(progress * 100);
  const inspectedImage =
    imageInfo && binPath && imageInfo.path === binPath ? imageInfo : null;
  const imageOk = inspectedImage?.valid === true && inspectedImage?.hash_match === true;

  const activeStep = PHASE_STEP[phase];
  const lastStepRef = useRef(-1);
  useEffect(() => {
    if (activeStep !== undefined) {
      lastStepRef.current = activeStep;
    }
  }, [activeStep]);
  const shownStep = phase === "complete" ? OTA_STEPS.length : activeStep ?? lastStepRef.current;

  const pickImage = async () => {
    const file = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "已签名固件", extensions: ["bin"] }],
    });
    if (typeof file === "string") {
      setImagePath(file);
      void inspect(file);
    }
  };

  const copy = async (text: string, key: "result" | "logs") => {
    if (!navigator.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      if (copyTimer.current !== null) {
        window.clearTimeout(copyTimer.current);
      }
      copyTimer.current = window.setTimeout(() => setCopied(null), 1500);
    } catch {
      /* 剪贴板不可用时静默忽略 */
    }
  };

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) {
        window.clearTimeout(copyTimer.current);
      }
    };
  }, []);

  const imageCounter = inspectedImage?.security_counter ?? null;
  const deviceCounter = deviceInfo?.security_counter ?? null;
  const imageOverCapacity = imageCounter !== null && imageCounter > 4096;
  const rollbackBlocked =
    deviceCounter !== null &&
    (imageCounter === null || imageCounter < deviceCounter || imageOverCapacity);

  const imageVersion = inspectedImage?.version ?? null;
  const deviceVersion = deviceInfo?.primary_version ?? null;
  const versionOrder =
    imageVersion && deviceVersion ? compareVersions(imageVersion, deviceVersion) : null;
  const versionBlocked = versionGuard && versionOrder !== null && versionOrder < 0;

  const preflight: { state: PreflightState; label: string; detail: string }[] = [
    {
      state: connected ? "ok" : "warn",
      label: "串口",
      detail: connected
        ? `${serialForm.port} @ ${serialForm.baudRate}`
        : "未连接，开始时会自动连接",
    },
    {
      state: binPath ? "ok" : "warn",
      label: "固件",
      detail: binPath ? fileName(binPath) : "未选择 · 可在上方签名或点“选择固件”",
    },
    {
      state: !inspectedImage ? "info" : imageOk ? "ok" : "warn",
      label: "镜像",
      detail: !inspectedImage
        ? "未校验（可选）"
        : `${inspectedImage.version ? `v${inspectedImage.version}` : "无版本"} · ${
            imageOk ? "哈希通过" : inspectedImage.valid ? "哈希未通过" : "结构无效"
          } · 计数器 ${inspectedImage.security_counter ?? "缺失"}`,
    },
    {
      state: deviceInfo ? "ok" : "info",
      label: "设备",
      detail: deviceInfo
        ? `主槽 ${deviceInfo.primary_version ? `v${deviceInfo.primary_version}` : "空"} · 副槽 ${
            deviceInfo.secondary_version ? `v${deviceInfo.secondary_version}` : "空"
          } · 计数器 ${deviceInfo.security_counter ?? "—"}`
        : "未读取（可选）",
    },
    {
      state: deviceCounter === null ? "info" : rollbackBlocked ? "warn" : "ok",
      label: "防回滚",
      detail:
        deviceCounter === null
          ? "未读取设备计数器"
          : imageCounter === null
            ? "镜像缺少 SEC_CNT，会被 Boot 拒绝"
            : imageOverCapacity
              ? `镜像 ${imageCounter} 超出 OTP 容量（0..4096）`
              : imageCounter < deviceCounter
                ? `镜像 ${imageCounter} < 设备 ${deviceCounter}，会被 Boot 拒绝`
                : `镜像 ${imageCounter} ≥ 设备 ${deviceCounter}`,
    },
    {
      state: !versionGuard || versionOrder === null ? "info" : versionBlocked ? "warn" : "ok",
      label: "版本",
      detail: !versionGuard
        ? "未启用版本降级检查"
        : !imageVersion
          ? "镜像未校验版本（OTA 时后台仍会检查）"
          : !deviceVersion
            ? "未读取设备主槽版本（OTA 时后台仍会检查）"
            : versionOrder === null
              ? "版本格式无法比较"
              : versionBlocked
                ? `镜像 v${imageVersion} < 主槽 v${deviceVersion}，已阻止`
                : `镜像 v${imageVersion} ≥ 主槽 v${deviceVersion}`,
    },
  ];

  const resultText = otaResult
    ? [
        "串口 OTA 结果",
        `大小: ${formatBytes(otaResult.total_size)}`,
        `CRC32: ${otaResult.crc32.toString(16).toUpperCase().padStart(8, "0")}`,
        `SHA-256: ${otaResult.sha256}`,
        `耗时: ${(otaResult.duration_ms / 1000).toFixed(1)} s`,
        otaResult.device?.primary_version
          ? `升级前主槽: v${otaResult.device.primary_version}`
          : "",
        otaResult.running_version
          ? `升级后运行: v${otaResult.running_version}`
          : "升级后运行: 未确认",
        `校验: ${otaResult.verified ? "一致" : "不一致"}`,
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const firmwareCard = (
    <Card>
      <CardContent className="p-4">
        {binPath ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                {running ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <FileCode2 className="h-5 w-5" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-sm font-medium" title={binPath}>
                  {fileName(binPath)}
                </div>
                <div className="truncate text-xs text-muted-foreground" title={binPath}>
                  {binPath}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5"
                disabled={running}
                onClick={() => void pickImage()}
              >
                <FolderOpen className="h-3.5 w-3.5" />
                更换固件
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              {inspectedImage ? (
                <>
                  <span
                    className={cn(
                      "flex items-center gap-1",
                      imageOk ? "text-success" : "text-warning"
                    )}
                  >
                    {imageOk ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : (
                      <AlertTriangle className="h-3.5 w-3.5" />
                    )}
                    {imageOk ? "MCUboot" : inspectedImage.valid ? "哈希未通过" : "结构无效"}
                  </span>
                  <span className="terminal-font">v{inspectedImage.version ?? "—"}</span>
                  <span className="text-muted-foreground">
                    镜像 {formatBytes(inspectedImage.image_size)}
                  </span>
                  <span className="text-muted-foreground">
                    SEC_CNT {inspectedImage.security_counter ?? "缺失"}
                  </span>
                  <span className="ml-auto text-muted-foreground">
                    {formatBytes(inspectedImage.file_size)}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground/70">
                  尚未解析镜像，OTA 前会自动校验
                </span>
              )}
            </div>

            {running && (
              <div className="space-y-1.5">
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all duration-200",
                      phase === "complete"
                        ? "bg-success"
                        : phase === "error"
                          ? "bg-destructive"
                          : "bg-primary"
                    )}
                    style={{ width: `${Math.max(2, percent)}%` }}
                  />
                </div>
                <div className="flex justify-between gap-3 text-xs text-muted-foreground">
                  <span className="truncate">{PHASE_LABELS[phase] ?? phase}</span>
                  <span className="shrink-0 font-medium text-primary">
                    {percent}% · {formatBytes(sent)} / {formatBytes(total)}
                  </span>
                </div>
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void pickImage()}
            disabled={running}
            className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/70 bg-muted/20 py-8 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-60"
          >
            <FolderOpen className="h-6 w-6" />
            <span className="text-xs">选择已签名固件（.bin）</span>
            <span className="text-[10px] text-muted-foreground/60">
              也可在下方签名面板生成
            </span>
          </button>
        )}
      </CardContent>
    </Card>
  );

  const signCard = (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 py-3">
        <PenLine className="h-4 w-4 text-primary" />
        <CardTitle className="text-sm">签名固件</CardTitle>
      </CardHeader>
      <CardContent>
        <SignPanel />
      </CardContent>
    </Card>
  );

  const upgradeCard = (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 py-3">
        <Rocket className="h-4 w-4 text-primary" />
        <CardTitle className="text-sm">串口 OTA</CardTitle>
        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
          免探针
        </span>
        {running && (
          <span className="ml-auto text-[10.5px] text-muted-foreground">
            {PHASE_LABELS[phase] ?? phase}
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-lg border bg-muted/20 p-2">
          {preflight.map((item) => (
            <PreflightRow key={item.label} state={item.state} label={item.label} detail={item.detail} />
          ))}
        </div>

        <div className="flex gap-2">
          <Button
            className="flex-1"
            disabled={running || rollbackBlocked || versionBlocked || !binPath}
            onClick={() => void start(binPath, versionGuard)}
          >
            {running ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                升级中...
              </>
            ) : (
              <>
                <Rocket className="mr-1.5 h-4 w-4" />
                开始串口 OTA
              </>
            )}
          </Button>
          {running && (
            <Button variant="outline" onClick={cancel}>
              取消
            </Button>
          )}
        </div>

        {(running || phase !== "idle") && (
          <div className="space-y-2">
            <div className="grid grid-cols-4 gap-1">
              {OTA_STEPS.map((step, index) => (
                <div
                  key={step}
                  className={cn(
                    "flex items-center gap-1",
                    index < shownStep
                      ? "text-success"
                      : index === shownStep && (running || phase === "error")
                        ? "text-primary"
                        : "text-muted-foreground/50"
                  )}
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px]",
                      index < shownStep
                        ? "border-success bg-success/10"
                        : index === shownStep && (running || phase === "error")
                          ? "border-primary bg-primary/10"
                          : "border-border"
                    )}
                  >
                    {index < shownStep ? <Check className="h-2.5 w-2.5" /> : index + 1}
                  </span>
                  <span className="truncate text-[10px]">{step}</span>
                </div>
              ))}
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>{PHASE_LABELS[phase] ?? phase}</span>
              <span>
                {percent}% · {formatBytes(sent)} / {formatBytes(total)}
              </span>
            </div>
          </div>
        )}

        {error && (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
            {error}
          </p>
        )}

        {otaResult && (
          <div
            className={cn(
              "space-y-1 rounded-lg border p-2.5 text-[11px]",
              otaResult.verified
                ? "border-success/40 bg-success/10"
                : "border-warning/40 bg-warning/10"
            )}
          >
            <div className="flex items-center gap-2">
              {otaResult.verified ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 text-warning" />
              )}
              <span className="font-medium">
                升级完成 · {formatBytes(otaResult.total_size)} · CRC32{" "}
                {otaResult.crc32.toString(16).toUpperCase().padStart(8, "0")}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-6 gap-1 px-1.5 text-[10px]"
                onClick={() => void copy(resultText, "result")}
              >
                <Copy className="h-3 w-3" />
                {copied === "result" ? "已复制" : "复制"}
              </Button>
            </div>
            <p className="text-muted-foreground">
              耗时 {(otaResult.duration_ms / 1000).toFixed(1)} s · 运行版本{" "}
              {otaResult.running_version ? `v${otaResult.running_version}` : "未确认"}
            </p>
            {!otaResult.verified && (
              <p className="text-warning">校验：运行版本与目标版本不一致</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );

  const deviceCard = (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 py-3">
        <Cpu className="h-4 w-4 text-primary" />
        <CardTitle className="text-sm">设备信息</CardTitle>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 gap-1 px-2 text-[11px]"
          disabled={!connected || running || readingDevice}
          onClick={() => void readDeviceInfo()}
        >
          {readingDevice ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {readingDevice ? "读取中" : "读取"}
        </Button>
      </CardHeader>
      <CardContent>
        {deviceInfo ? (
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
            <div>
              <p className="text-muted-foreground">Boot</p>
              <p className="terminal-font">v{deviceInfo.boot_version || "—"}</p>
            </div>
            <div>
              <p className="text-muted-foreground">协议</p>
              <p>v{deviceInfo.protocol_version}</p>
            </div>
            <div>
              <p className="text-muted-foreground">主槽</p>
              <p>{deviceInfo.primary_version ? `v${deviceInfo.primary_version}` : "空"}</p>
            </div>
            <div>
              <p className="text-muted-foreground">副槽</p>
              <p>{deviceInfo.secondary_version ? `v${deviceInfo.secondary_version}` : "空"}</p>
            </div>
            <div>
              <p className="text-muted-foreground">槽容量</p>
              <p>{formatBytes(deviceInfo.slot_size)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">安全计数</p>
              <p className="terminal-font">{deviceInfo.security_counter ?? "—"}</p>
            </div>
            <div className="col-span-2">
              <p className="text-muted-foreground">UID</p>
              <p className="terminal-font truncate" title={deviceInfo.uid}>
                {deviceInfo.uid || "—"}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground/70">
            尚未读取。连接后点击工具栏“读取设备”，查询主/副槽版本与安全计数。
          </p>
        )}
      </CardContent>
    </Card>
  );

  const settingsCard = (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 py-3">
        <ShieldCheck className="h-4 w-4 text-primary" />
        <CardTitle className="text-sm">升级设置</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            className="mt-0.5 h-3.5 w-3.5"
            checked={versionGuard}
            disabled={running}
            onChange={(e) => setVersionGuard(e.target.checked)}
          />
          <span className="flex flex-col gap-0.5">
            <span>禁止版本降级</span>
            <span className="text-[10.5px] text-muted-foreground">
              镜像版本低于设备主槽版本时阻止 OTA
            </span>
          </span>
        </label>

        <div className="grid grid-cols-2 gap-1.5 text-[10.5px]">
          <div className="rounded-lg bg-muted/40 px-2 py-1.5">
            <p className="text-muted-foreground">镜像安全计数</p>
            <p className="terminal-font text-foreground">{imageCounter ?? "—"}</p>
          </div>
          <div className="rounded-lg bg-muted/40 px-2 py-1.5">
            <p className="text-muted-foreground">设备安全计数</p>
            <p className="terminal-font text-foreground">{deviceCounter ?? "—"}</p>
          </div>
        </div>

        <p className="text-[10.5px] text-muted-foreground">
          目标：Secondary 副槽 · 槽容量 {deviceInfo ? formatBytes(deviceInfo.slot_size) : "384.0 KB"}
        </p>
        <p className="text-[10px] text-muted-foreground/60">
          设备端仍会校验签名与安全计数器，版本检查只在上位机执行。
        </p>
      </CardContent>
    </Card>
  );

  const logCard = logs.length > 0 && (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 py-2.5">
        <ScrollText className="h-4 w-4 text-primary" />
        <CardTitle className="text-sm">流程日志</CardTitle>
        <span className="text-[10px] text-muted-foreground/60">({logs.length})</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[10px]"
            onClick={() => void copy(logs.join("\n"), "logs")}
          >
            <Copy className="h-3 w-3" />
            {copied === "logs" ? "已复制" : "复制"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px]"
            onClick={() => setLogsOpen((open) => !open)}
          >
            {logsOpen ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </CardHeader>
      {logsOpen && (
        <CardContent className="p-0">
          <div
            ref={logRef}
            className="terminal-font max-h-40 overflow-y-auto border-t px-3 py-2 text-[10.5px] leading-relaxed"
          >
            {logs.map((line, index) => (
              <div key={`${index}-${line}`}>{line}</div>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-4">
        {firmwareCard}
        {signCard}
        {upgradeCard}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {deviceCard}
        {settingsCard}
        <SlotStatusPanel />
        {logCard}
      </div>
    </div>
  );
}
