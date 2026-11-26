import { type ReactNode, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Cable,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Cpu,
  FolderOpen,
  Loader2,
  MinusCircle,
  RefreshCw,
  Rocket,
} from "lucide-react";
import { useOtaStore } from "@/stores/otaStore";
import { useSerialStore } from "@/stores/serialStore";
import { useSerialOtaStore } from "@/stores/serialOtaStore";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cn, formatBytes } from "@/lib/utils";

const PHASE_LABELS: Record<string, string> = {
  idle: "待开始",
  connecting: "连接串口",
  enter: "进入 Boot",
  query: "查询设备",
  start: "擦除副槽",
  data: "写入镜像",
  end: "校验镜像",
  apply: "触发升级",
  verify: "回连校验",
  complete: "完成",
  cancelled: "已取消",
  error: "失败",
};

const STEPS = ["连接", "Boot", "查询", "擦除", "写入", "校验", "APPLY", "回连"];
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

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex h-5 items-center gap-1.5">
        <span className="text-[10px] font-medium tracking-wide text-muted-foreground/70">
          {title}
        </span>
        {action && <div className="ml-auto flex items-center gap-1">{action}</div>}
      </div>
      {children}
    </section>
  );
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

  const ports = useSerialStore((s) => s.ports);
  const serialForm = useSerialStore((s) => s.form);
  const setSerialForm = useSerialStore((s) => s.setForm);
  const refreshPorts = useSerialStore((s) => s.refreshPorts);
  const connect = useSerialStore((s) => s.connect);
  const disconnect = useSerialStore((s) => s.disconnect);
  const connected = useSerialStore((s) => s.connected);
  const serialError = useSerialStore((s) => s.error);

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
  const failed = phase === "error" || phase === "cancelled";
  const shownStep = phase === "complete" ? STEPS.length : activeStep ?? lastStepRef.current;

  const pickImage = async () => {
    const file = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "已签名固件", extensions: ["bin"] }],
    });
    if (typeof file === "string") {
      setImagePath(file);
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

  // 端口热插拔：未连接且没有 OTA 任务时每 2s 刷新
  useEffect(() => {
    void refreshPorts();
    const timer = window.setInterval(() => {
      if (!useSerialStore.getState().connected && !useSerialOtaStore.getState().running) {
        void refreshPorts();
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refreshPorts]);

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
      detail: binPath ? fileName(binPath) : "未选择 · 左侧签名或点“选择”",
    },
    {
      state: !inspectedImage ? "info" : imageOk ? "ok" : "warn",
      label: "镜像",
      detail: !inspectedImage
        ? "未校验（可选）"
        : `${inspectedImage.version ? `v${inspectedImage.version}` : "无版本"} · ${
            imageOk ? "哈希通过" : inspectedImage.valid ? "哈希未通过" : "结构无效"
          }`,
    },
    {
      state: deviceInfo ? "ok" : "info",
      label: "设备",
      detail: deviceInfo
        ? `主槽 ${deviceInfo.primary_version ? `v${deviceInfo.primary_version}` : "空"} · 副槽 ${
            deviceInfo.secondary_version ? `v${deviceInfo.secondary_version}` : "空"
          }`
        : "未读取（可选）",
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

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2">
        <Cable className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">串口 OTA</h2>
        <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          免探针
        </span>
      </div>

      <Section title="连接">
        {connected ? (
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-2.5 py-1.5 text-[11px]">
            <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
            <span className="terminal-font truncate">{serialForm.port}</span>
            <span className="text-muted-foreground">@{serialForm.baudRate}</span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6 px-2 text-[11px]"
              disabled={running}
              onClick={() => void disconnect()}
            >
              断开
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Select
              value={serialForm.port}
              onChange={(e) => setSerialForm({ port: e.target.value })}
              disabled={running}
              className="h-8 text-xs"
            >
              {ports.length === 0 && <option value="">（未检测到串口）</option>}
              {ports.map((port) => (
                <option key={port.name} value={port.name}>
                  {port.name}
                  {port.description ? ` - ${port.description}` : ""}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              className="h-8 shrink-0"
              disabled={!serialForm.port || running}
              onClick={() => void connect()}
            >
              连接
            </Button>
          </div>
        )}

        {serialForm.baudRate !== 115200 && (
          <p className="text-[10.5px] text-warning">
            设备端固定 115200 8N1，当前波特率可能无法通信。
            <button
              type="button"
              className="ml-1 underline underline-offset-2"
              onClick={() => setSerialForm({ baudRate: 115200 })}
            >
              改为 115200
            </button>
          </p>
        )}

        {!connected && serialError && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[10.5px] leading-relaxed text-destructive">
            串口连接失败：{serialError}
          </p>
        )}
      </Section>

      <Section
        title="设备"
        action={
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[10px]"
            disabled={running || readingDevice}
            onClick={() => void readDeviceInfo()}
          >
            <RefreshCw className={cn("mr-1 h-3 w-3", readingDevice && "animate-spin")} />
            {readingDevice ? "读取中" : "读取"}
          </Button>
        }
      >
        {deviceInfo ? (
          <div className="rounded-lg border bg-muted/30 p-2.5 text-[10.5px] leading-relaxed">
            <div className="flex items-center gap-1.5">
              <Cpu className="h-3.5 w-3.5 text-primary" />
              <span className="font-medium">设备信息</span>
              <span className="ml-auto text-muted-foreground">
                协议 v{deviceInfo.protocol_version} · Boot {deviceInfo.boot_version}
              </span>
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground">
              <span>
                运行槽{" "}
                <span className="terminal-font text-foreground">{deviceInfo.active_slot}</span>
              </span>
              <span>
                主槽{" "}
                <span className="terminal-font text-foreground">
                  {deviceInfo.primary_version ? `v${deviceInfo.primary_version}` : "空"}
                </span>
              </span>
              <span>
                副槽{" "}
                <span className="terminal-font text-foreground">
                  {deviceInfo.secondary_version ? `v${deviceInfo.secondary_version}` : "空"}
                </span>
              </span>
              <span>
                槽容量{" "}
                <span className="terminal-font text-foreground">
                  {deviceInfo.slot_size ? formatBytes(deviceInfo.slot_size) : "—"}
                </span>
              </span>
              <span className="col-span-2 break-all">
                UID{" "}
                <span className="terminal-font text-foreground">{deviceInfo.uid || "—"}</span>
              </span>
              <span className="col-span-2">
                交换状态 <span className="text-foreground">{deviceInfo.swap_state}</span>
              </span>
            </div>
          </div>
        ) : (
          <p className="text-[10px] leading-relaxed text-muted-foreground/70">
            尚未读取。读取会让设备重启进入 Boot 查询，随后自动返回应用，不会修改固件。
          </p>
        )}
      </Section>

      <Section title="固件">
        <div className="flex items-center gap-2">
          <p
            className={cn(
              "min-w-0 flex-1 truncate text-[11px]",
              binPath ? "text-muted-foreground" : "text-warning"
            )}
            title={binPath}
          >
            {binPath || "（未选择已签名 .bin）"}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-6 shrink-0 px-2 text-[11px]"
            disabled={running}
            onClick={() => void pickImage()}
          >
            <FolderOpen className="mr-1 h-3 w-3" />
            选择
          </Button>
        </div>
      </Section>

      <Section title="升级">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-lg border bg-muted/20 p-2">
          {preflight.map((item) => (
            <PreflightRow key={item.label} {...item} />
          ))}
        </div>

        <div className="flex gap-2">
          <Button
            className="flex-1"
            disabled={running}
            onClick={() => void start(binPath)}
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
            <Button variant="outline" onClick={() => void cancel()}>
              取消
            </Button>
          )}
        </div>

        {(running || phase !== "idle") && (
          <div className="flex flex-col gap-1.5 rounded-lg border bg-muted/20 p-2">
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span
                className={cn(
                  "font-medium",
                  phase === "complete"
                    ? "text-success"
                    : phase === "error"
                      ? "text-destructive"
                      : "text-foreground"
                )}
              >
                {PHASE_LABELS[phase] ?? phase}
                {phase === "data" ? ` ${percent}%` : ""}
              </span>
              {total > 0 && (
                <span className="terminal-font text-[10.5px] text-muted-foreground">
                  {formatBytes(sent)} / {formatBytes(total)}
                </span>
              )}
            </div>

            <div className="flex items-start gap-1">
              {STEPS.map((label, index) => {
                const done = shownStep > index;
                const current = index === shownStep;
                return (
                  <div key={label} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                    <div
                      className={cn(
                        "flex h-4 w-4 items-center justify-center rounded-full border text-[9px]",
                        done && "border-primary bg-primary text-primary-foreground",
                        current && !failed && "border-primary text-primary",
                        current && failed && "border-destructive text-destructive",
                        !done && !current && "border-border text-muted-foreground/50"
                      )}
                    >
                      {done ? <Check className="h-2.5 w-2.5" /> : index + 1}
                    </div>
                    <span
                      className={cn(
                        "w-full truncate text-center text-[9px] leading-none",
                        current && failed
                          ? "text-destructive"
                          : current
                            ? "text-foreground"
                            : done
                              ? "text-foreground/70"
                              : "text-muted-foreground/50"
                      )}
                    >
                      {label}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-200",
                  phase === "complete"
                    ? "bg-emerald-500"
                    : phase === "error"
                      ? "bg-destructive"
                      : "bg-primary"
                )}
                style={{ width: `${Math.max(2, percent)}%` }}
              />
            </div>
          </div>
        )}

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[10.5px] leading-relaxed text-destructive">
            {error}
          </p>
        )}

        {otaResult && (
          <div
            className={cn(
              "rounded-lg border p-2 text-[10.5px] leading-relaxed",
              otaResult.verified
                ? "border-success/40 bg-success/10 text-success"
                : "border-warning/40 bg-warning/10 text-warning"
            )}
          >
            <div className="flex items-center gap-1.5">
              {otaResult.verified ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="font-medium">
                {otaResult.verified ? "升级完成，版本校验一致" : "升级完成，版本校验未通过"}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-5 px-1.5 text-[10px]"
                onClick={() => void copy(resultText, "result")}
              >
                {copied === "result" ? "已复制" : <Copy className="h-3 w-3" />}
              </Button>
            </div>
            <p className="mt-1">
              升级完成：{formatBytes(otaResult.total_size)} · CRC32{" "}
              <span className="terminal-font">
                {otaResult.crc32.toString(16).toUpperCase().padStart(8, "0")}
              </span>{" "}
              · {(otaResult.duration_ms / 1000).toFixed(1)} s
            </p>
            <p className="truncate terminal-font" title={otaResult.sha256}>
              SHA-256 {otaResult.sha256}
            </p>
            {otaResult.device?.primary_version && (
              <p className="text-muted-foreground">
                升级前主槽 v{otaResult.device.primary_version}
                {otaResult.device.secondary_version
                  ? ` · 副槽 v${otaResult.device.secondary_version}`
                  : " · 副槽为空"}
              </p>
            )}
            <p>
              {otaResult.running_version
                ? `升级后运行 v${otaResult.running_version}${
                    otaResult.verified ? "（校验一致）" : "（与目标版本不一致）"
                  }`
                : "未能回连确认升级结果，请手动检查设备"}
            </p>
          </div>
        )}

        {logs.length > 0 && (
          <div className="rounded-lg border bg-muted/30">
            <div className="flex h-7 items-center gap-1.5 border-b px-2">
              <span className="text-[10px] font-medium tracking-wide text-muted-foreground/70">
                流程日志
              </span>
              <span className="text-[10px] text-muted-foreground/50">{logs.length}</span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-5 px-1.5 text-[10px]"
                onClick={() => void copy(logs.join("\n"), "logs")}
              >
                {copied === "logs" ? "已复制" : <Copy className="h-3 w-3" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={() => setLogsOpen((v) => !v)}
              >
                {logsOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </Button>
            </div>
            {logsOpen && (
              <div
                ref={logRef}
                className="terminal-font max-h-32 overflow-y-auto px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground"
              >
                {logs.map((line, index) => (
                  <div key={index} className="whitespace-pre-wrap break-all">
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}
