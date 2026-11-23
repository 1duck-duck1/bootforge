import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Loader2,
  Rocket,
  Send,
  XCircle,
} from "lucide-react";
import { useOtaStore } from "@/stores/otaStore";
import { useSerialStore } from "@/stores/serialStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn, formatBytes } from "@/lib/utils";

function hex(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;
}

function StepIcon({ status }: { status: "pending" | "running" | "done" | "failed" }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />;
  if (status === "done") return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />;
  if (status === "failed") return <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />;
  return <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />;
}

export function UpgradeGuide() {
  const serialConnected = useSerialStore((s) => s.connected);
  const send = useSerialStore((s) => s.send);
  const form = useOtaStore((s) => s.form);
  const result = useOtaStore((s) => s.result);
  const flowSteps = useOtaStore((s) => s.flowSteps);
  const flowRunning = useOtaStore((s) => s.flowRunning);
  const flowError = useOtaStore((s) => s.flowError);
  const runOneClick = useOtaStore((s) => s.runOneClick);
  const probeConnected = useOtaStore((s) => s.connected);
  const partition = useSettingsStore((s) => s.partition);

  const hasBin = Boolean(form.inputPath || form.outputPath || result);
  const missing = [
    !hasBin && "未选择固件",
    !probeConnected && "探针未连接",
    !serialConnected && "串口未连接",
  ].filter(Boolean) as string[];

  const bootBase = 0x0800_0000;
  const bootSize = partition.primaryBase - bootBase;
  const primaryEnd = partition.primaryBase + partition.slotSize - 1;
  const secondaryEnd = partition.secondaryBase + partition.slotSize - 1;
  const scratchEnd = partition.scratchBase + partition.scratchSize - 1;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex items-center gap-2">
        <Rocket className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">升级流程</h2>
      </div>

      {/* 一键升级 */}
      <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
        <div className="flex items-center gap-2">
          <p className="text-xs font-semibold">一键升级</p>
          <Tooltip
            label={
              missing.length > 0 ? missing.join(" · ") : "签名校验通过后自动烧录 Secondary 并触发升级"
            }
          >
            <span className="ml-auto">
              <Button
                size="sm"
                disabled={flowRunning || missing.length > 0}
                onClick={() => void runOneClick()}
              >
                {flowRunning ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    执行中...
                  </>
                ) : (
                  <>
                    <Rocket className="h-3.5 w-3.5" />
                    开始升级
                  </>
                )}
              </Button>
            </span>
          </Tooltip>
        </div>

        {missing.length > 0 && (
          <p className="mt-1.5 flex items-center gap-1 text-[10.5px] text-muted-foreground">
            <AlertCircle className="h-3 w-3" />
            还需：{missing.join(" · ")}
          </p>
        )}

        <ol className="mt-2.5 flex flex-col gap-1.5">
          {flowSteps.map((step) => (
            <li key={step.id} className="flex items-start gap-2">
              <span className="mt-0.5">
                <StepIcon status={step.status} />
              </span>
              <div className="min-w-0">
                <p
                  className={cn(
                    "text-[11px]",
                    step.status === "failed"
                      ? "text-destructive"
                      : step.status === "done"
                        ? "text-foreground"
                        : step.status === "running"
                          ? "text-primary"
                          : "text-muted-foreground"
                  )}
                >
                  {step.label}
                </p>
                {step.detail && (
                  <p className="truncate text-[10.5px] text-muted-foreground" title={step.detail}>
                    {step.detail}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>

        {flowError && (
          <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[10.5px] leading-relaxed text-destructive">
            {flowError}
          </p>
        )}
      </div>

      {/* 手动触发 */}
      <div className="rounded-lg border bg-muted/30 p-3">
        <p className="text-xs font-semibold">手动触发</p>
        <div className="mt-2 flex gap-2">
          <Tooltip label="boot_set_pending + 系统复位">
            <Button
              size="sm"
              className="flex-1"
              disabled={!serialConnected}
              onClick={() => void send("p", "none")}
            >
              <Send className="h-3.5 w-3.5" />
              发送 p · 触发升级
            </Button>
          </Tooltip>
          <Tooltip label="boot_swap_type() 查询交换状态">
            <Button
              size="sm"
              variant="outline"
              disabled={!serialConnected}
              onClick={() => void send("s", "none")}
            >
              查询 s
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* 分区布局（随设置中心变化） */}
      <div className="rounded-lg bg-muted/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
        <p className="mb-1 font-semibold text-foreground">Flash 分区参考</p>
        <p className="terminal-font">
          Boot&nbsp;&nbsp;&nbsp;&nbsp; {hex(bootBase)} - {hex(partition.primaryBase - 1)}&nbsp; (
          {formatBytes(bootSize)})
        </p>
        <p className="terminal-font">
          Primary {hex(partition.primaryBase)} - {hex(primaryEnd)}&nbsp; ({formatBytes(partition.slotSize)})
        </p>
        <p className="terminal-font">
          Secondary {hex(partition.secondaryBase)} - {hex(secondaryEnd)}&nbsp; (
          {formatBytes(partition.slotSize)})
        </p>
        <p className="terminal-font">
          Scratch&nbsp; {hex(partition.scratchBase)} - {hex(scratchEnd)}&nbsp; (
          {formatBytes(partition.scratchSize)})
        </p>
      </div>
    </div>
  );
}
