import { type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  FileUp,
  FolderOpen,
  Loader2,
  PenLine,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useOtaStore } from "@/stores/otaStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { cn, formatBytes } from "@/lib/utils";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function SignPanel() {
  const form = useOtaStore((s) => s.form);
  const setForm = useOtaStore((s) => s.setForm);
  const signing = useOtaStore((s) => s.signing);
  const signLogs = useOtaStore((s) => s.signLogs);
  const result = useOtaStore((s) => s.result);
  const sign = useOtaStore((s) => s.sign);
  const imageInfo = useOtaStore((s) => s.imageInfo);
  const imageInfoError = useOtaStore((s) => s.imageInfoError);
  const inspectingImage = useOtaStore((s) => s.inspectingImage);
  const inspect = useOtaStore((s) => s.inspect);

  const pickInput = async () => {
    const file = await open({
      title: "选择待签名的固件",
      filters: [{ name: "固件", extensions: ["bin"] }],
    });
    if (typeof file === "string") {
      const output = file.replace(/\.bin$/i, "") + "_signed.bin";
      setForm({ inputPath: file, outputPath: output });
    }
  };

  const pickOutput = async () => {
    const file = await open({
      title: "选择签名输出位置",
      filters: [{ name: "签名固件", extensions: ["bin"] }],
    });
    if (typeof file === "string") {
      setForm({ outputPath: file });
    }
  };

  const hashOk = imageInfo?.hash_match === true;
  const hashBad = imageInfo?.hash_match === false;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex items-center gap-2">
        <PenLine className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">imgtool 签名</h2>
      </div>

      <Field label="固件文件（.bin）">
        <div className="flex gap-2">
          <Input
            value={form.inputPath}
            onChange={(e) => setForm({ inputPath: e.target.value })}
            placeholder="点击右侧按钮选择，或直接输入路径"
            className="terminal-font text-xs"
            spellCheck={false}
          />
          <Button variant="outline" size="sm" className="h-9 shrink-0" onClick={() => void pickInput()}>
            <FileUp className="h-3.5 w-3.5" />
            选择
          </Button>
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="版本号">
          <Input
            value={form.version}
            onChange={(e) => setForm({ version: e.target.value })}
            placeholder="1.0.0"
            className="terminal-font text-xs"
            spellCheck={false}
          />
        </Field>
        <Field label="输出（签名后固件）">
          <div className="flex gap-2">
            <Input
              value={form.outputPath}
              onChange={(e) => setForm({ outputPath: e.target.value })}
              placeholder="xxx_signed.bin"
              className="terminal-font text-xs"
              spellCheck={false}
            />
            <Button variant="outline" size="sm" className="h-9 shrink-0" onClick={() => void pickOutput()}>
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
          </div>
        </Field>
      </div>

      <Button onClick={() => void sign()} disabled={signing || !form.inputPath} className="w-full">
        {signing ? (
          <>
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            签名中...
          </>
        ) : (
          "开始签名"
        )}
      </Button>

      {result && (
        <p className="rounded-lg border border-success/40 bg-success/10 p-2.5 text-xs text-success">
          签名完成：{result.output_path}（{formatBytes(result.size)}）
        </p>
      )}

      {!signing && !result && signLogs.length > 0 && (
        <p
          className="truncate rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive"
          title={signLogs.join("\n")}
        >
          {signLogs[signLogs.length - 1]}
        </p>
      )}

      {/* 镜像结构 / 哈希校验 */}
      <div className="rounded-lg border bg-muted/20">
        <div className="flex h-8 items-center gap-1.5 border-b px-2.5">
          <ShieldCheck className="h-3.5 w-3.5 text-primary" />
          <span className="text-[11px] font-medium">镜像校验</span>
          {imageInfo && (
            <span className="truncate text-[10.5px] text-muted-foreground">
              {fileName(imageInfo.path)}
            </span>
          )}
          <Tooltip label="重新校验输出固件">
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto h-6 w-6"
              disabled={inspectingImage || (!form.outputPath && !result)}
              onClick={() => void inspect(result?.output_path ?? form.outputPath)}
            >
              <RefreshCw className={cn("h-3 w-3", inspectingImage && "animate-spin")} />
            </Button>
          </Tooltip>
        </div>

        <div className="p-2.5 text-[11px] leading-relaxed">
          {inspectingImage ? (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              正在解析镜像...
            </p>
          ) : imageInfoError ? (
            <p className="flex items-start gap-1.5 text-destructive">
              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {imageInfoError}
            </p>
          ) : !imageInfo ? (
            <p className="text-muted-foreground/70">尚未校验。</p>
          ) : !imageInfo.valid ? (
            <p className="flex items-start gap-1.5 text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {imageInfo.message}
                <span className="ml-1 terminal-font text-muted-foreground">
                  （magic 0x{imageInfo.magic.toString(16).toUpperCase()}，{formatBytes(imageInfo.file_size)}）
                </span>
              </span>
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                {hashOk ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                ) : hashBad ? (
                  <XCircle className="h-3.5 w-3.5 text-destructive" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 text-warning" />
                )}
                <span
                  className={cn(
                    "font-medium",
                    hashOk ? "text-success" : hashBad ? "text-destructive" : "text-warning"
                  )}
                >
                  {hashOk
                    ? `${imageInfo.hash_algorithm ?? "哈希"} 校验通过`
                    : hashBad
                      ? `${imageInfo.hash_algorithm ?? "哈希"} 校验失败`
                      : "缺少哈希 TLV"}
                </span>
                <span className="ml-auto terminal-font text-[10.5px] text-muted-foreground">
                  v{imageInfo.version}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground">
                <span>
                  镜像体 <span className="terminal-font text-foreground">{formatBytes(imageInfo.image_size)}</span>
                </span>
                <span>
                  加载地址{" "}
                  <span className="terminal-font text-foreground">
                    0x{imageInfo.load_addr.toString(16).toUpperCase()}
                  </span>
                </span>
                <span>
                  Header{" "}
                  <span className="terminal-font text-foreground">
                    0x{imageInfo.header_size.toString(16).toUpperCase()}
                  </span>
                </span>
                <span>
                  文件 <span className="terminal-font text-foreground">{formatBytes(imageInfo.file_size)}</span>
                </span>
              </div>

              {imageInfo.hash_tlv && (
                <p className="terminal-font truncate text-[10px] text-muted-foreground" title={imageInfo.hash_tlv}>
                  {imageInfo.hash_algorithm}: {imageInfo.hash_tlv}
                </p>
              )}

              {imageInfo.tlvs.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {imageInfo.tlvs.map((tlv) => (
                    <span
                      key={`${tlv.tlv_type}-${tlv.len}`}
                      className="rounded border bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                      title={`${tlv.value}（${tlv.len} 字节）`}
                    >
                      {tlv.name}
                      {tlv.tlv_type === 0x50 ? `=${tlv.value}` : ""}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
