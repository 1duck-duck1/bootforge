import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { FileCode2 } from "lucide-react";
import { FlashContent } from "@/components/flash/FlashContent";
import { FlashToolbar } from "@/components/flash/FlashToolbar";
import { LogPanel } from "@/components/log/LogPanel";
import { useFlashStore } from "@/stores/flashStore";
import { useLogStore } from "@/stores/logStore";
import { cn } from "@/lib/utils";

function isFirmwareFile(path: string): boolean {
  return path.toLowerCase().endsWith(".bin");
}

/**
 * 固件烧录工作台
 *
 * 布局参考 OmniProbe Flash 模式：工具栏 + 内容卡片 + 底部日志，
 * 支持把 .bin 固件直接拖进窗口烧录。
 */
export function FlashMode() {
  const [isDragging, setIsDragging] = useState(false);
  const setFirmwarePath = useFlashStore((s) => s.setFirmwarePath);
  const inspect = useFlashStore((s) => s.inspect);
  const addLog = useLogStore((s) => s.addLog);

  useEffect(() => {
    // 浏览器预览没有 Tauri 拖放接口
    if (!("__TAURI_INTERNALS__" in window)) return;
    const webview = getCurrentWebviewWindow();

    const unlisten = webview.onDragDropEvent((event) => {
      if (event.payload.type === "enter") {
        const paths = event.payload.paths ?? [];
        if (paths.some(isFirmwareFile)) {
          setIsDragging(true);
        }
        return;
      }
      if (event.payload.type === "drop") {
        setIsDragging(false);
        const paths = event.payload.paths ?? [];
        const firmware = paths.find(isFirmwareFile);
        if (firmware) {
          setFirmwarePath(firmware);
          void inspect();
        } else if (paths.length > 0) {
          addLog("warn", "仅支持拖入 .bin 固件（imgtool 签名产物）");
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
  }, [setFirmwarePath, inspect, addLog]);

  return (
    <div
      className={cn(
        "surface-strong relative flex h-full min-h-0 flex-col gap-2 overflow-hidden rounded-[14px] p-2",
        isDragging && "ring-2 ring-inset ring-primary"
      )}
    >
      {/* 拖放遮罩 */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-primary bg-primary/5 p-6">
            <FileCode2 className="h-12 w-12 animate-bounce text-primary" />
            <p className="text-lg font-medium text-primary">释放以载入固件</p>
            <p className="text-xs text-muted-foreground">支持 imgtool --pad 生成的 .bin</p>
          </div>
        </div>
      )}

      <FlashToolbar />

      <div className="min-h-0 flex-1 overflow-hidden">
        <FlashContent />
      </div>

      <LogPanel className="mx-0 mb-0" />
    </div>
  );
}
