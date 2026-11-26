import { useEffect, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Cable, Cpu, FolderOpen, Loader2, RefreshCw, Rocket } from "lucide-react";
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

export function SerialOtaPanel() {
  const form = useOtaStore((s) => s.form);
  const signResult = useOtaStore((s) => s.result);

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

  const binPath = manualPath ?? signResult?.output_path ?? form.outputPath;
  const percent = Math.round(progress * 100);

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

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

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

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2">
        <Cable className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">串口 OTA</h2>
        <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          免探针
        </span>
      </div>

      {/* 串口连接 */}
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

      {/* 设备信息（协议 v2）：读取会重启设备进入 Boot 查询，随后自动返回应用 */}
      <div className="flex flex-col gap-1">
        <Button
          variant="outline"
          size="sm"
          className="h-7 w-full text-[11px]"
          disabled={running || readingDevice}
          onClick={() => void readDeviceInfo()}
        >
          <RefreshCw className={cn("mr-1 h-3 w-3", readingDevice && "animate-spin")} />
          {readingDevice ? "读取中..." : "读取设备状态"}
        </Button>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          读取状态会让设备重启进入 Boot 查询，随后自动返回应用，不会修改固件。
        </p>
      </div>

      {deviceInfo && (
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
      )}

      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={binPath}>
          固件：{binPath || "（未选择已签名 .bin）"}
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

      {!running && !connected && (
        <p className="text-[10.5px] leading-relaxed text-warning">
          串口未连接：点击“开始”会自动连接当前端口，也可先在上方点击“连接”。
        </p>
      )}
      {!running && connected && !binPath && (
        <p className="text-[10.5px] leading-relaxed text-warning">
          未选择固件：请先在左侧完成签名，或点击“选择”指定已签名 .bin。
        </p>
      )}

      {/* 进度 */}
      {(running || phase !== "idle") && (
        <div className="flex flex-col gap-1">
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
          <p>
            升级完成：{formatBytes(otaResult.total_size)} · CRC32{" "}
            <span className="terminal-font">
              {otaResult.crc32.toString(16).toUpperCase().padStart(8, "0")}
            </span>
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

      {/* 流程日志 */}
      {logs.length > 0 && (
        <div className="max-h-32 overflow-hidden rounded-lg border bg-muted/40">
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
        </div>
      )}

      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
        点击开始会先发送 OTA 握手命令，App 收到后复位进入 Boot；串口搬运与写 flash 全部由 Boot 完成，App 损坏时 Boot 会自动常驻 OTA。升级期间串口监视暂停，APPLY 后设备自动复位并由 MCUboot 完成交换，随后自动回连读取运行版本并返回应用。
      </p>
    </div>
  );
}
