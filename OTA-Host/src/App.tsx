import { Suspense, useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { ModeSwitch } from "@/components/layout/ModeSwitch";
import { TopBar } from "@/components/layout/TopBar";
import { SerialSidebar } from "@/components/serial/SerialSidebar";
import { RttStartPanel } from "@/components/rtt/RttStartPanel";
import { ProbeConnector } from "@/components/probe/ProbeConnector";
import { WORKSPACE_BY_MODE, WORKSPACE_REGISTRY } from "@/components/modes";
import { useAppStore } from "@/stores/appStore";
import { useFlashStore } from "@/stores/flashStore";
import { useLogStore } from "@/stores/logStore";
import { useRttEvents } from "@/hooks/useRttEvents";
import { useSerialEvents } from "@/hooks/useSerialEvents";

function App() {
  useSerialEvents();
  useRttEvents();

  const mode = useAppStore((s) => s.mode);
  const theme = useAppStore((s) => s.theme);
  const flashing = useFlashStore((s) => s.flashing);

  // 右侧检查器宽度可拖拽，复刻 OmniProbe Inspector 交互
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorWidth, setInspectorWidth] = useState(288);
  const showInspector = inspectorOpen && mode !== "ota";

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  // 全局快捷键：Ctrl+1..4 按注册顺序切换工作台
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isInInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (!e.ctrlKey || isInInput) return;
      const index = Number(e.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= WORKSPACE_REGISTRY.length) return;
      e.preventDefault();
      useAppStore.getState().setMode(WORKSPACE_REGISTRY[index].id);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 启动日志（StrictMode 下 effect 会执行两次，用标志去重）
  useEffect(() => {
    let mounted = true;
    const addLog = useLogStore.getState().addLog;
    requestAnimationFrame(() => {
      if (!mounted) return;
      addLog("info", "OTA-Host 已启动");
      addLog("info", "MCUboot OTA 上位机：串口监视 / imgtool 签名 / 升级触发");
    });
    return () => {
      mounted = false;
    };
  }, []);

  const WorkspaceView = WORKSPACE_BY_MODE[mode].view;

  return (
    <div className="app-shell flex h-screen flex-col overflow-hidden text-foreground">
      <div className="grid min-h-0 flex-1 grid-cols-[64px_minmax(0,1fr)] gap-2 p-2">
        {/* 左侧图标导航栏 */}
        <aside className="surface-shell flex min-h-0 flex-col items-center rounded-2xl p-2">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-[0_4px_12px_hsl(var(--primary)/0.3)]">
            <Cpu className="h-4 w-4" />
          </div>
          <ModeSwitch className="mt-2" />
        </aside>

        {/* 右列：顶栏 + 工作区 */}
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <TopBar
            inspectorOpen={showInspector}
            onToggleInspector={() => setInspectorOpen((open) => !open)}
          />
          <div
            className="grid min-h-0 overflow-hidden"
            style={
              showInspector
                ? { gridTemplateColumns: `minmax(0,1fr) 6px ${inspectorWidth}px` }
                : { gridTemplateColumns: "minmax(0,1fr)" }
            }
          >
            <div key={mode} className="surface-card min-h-0 min-w-0 overflow-hidden rounded-2xl">
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <Cpu className="h-5 w-5 animate-pulse text-muted-foreground" aria-label="加载工作台" />
                  </div>
                }
              >
                <WorkspaceView />
              </Suspense>
            </div>

            {showInspector && (
              <>
                <button
                  type="button"
                  aria-label="调整配置侧栏宽度"
                  className="group flex h-full cursor-col-resize items-center justify-center bg-transparent"
                  onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
                  onPointerMove={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                      setInspectorWidth(
                        Math.min(440, Math.max(240, window.innerWidth - event.clientX - 12))
                      );
                    }
                  }}
                >
                  <span className="h-10 w-px bg-border transition-colors group-hover:bg-primary group-focus-visible:bg-primary" />
                </button>
                <div className="surface-card min-h-0 min-w-0 overflow-hidden rounded-2xl">
                  {mode === "serial" ? (
                    <SerialSidebar />
                  ) : mode === "rtt" ? (
                    <RttStartPanel />
                  ) : (
                    <div className="h-full overflow-y-auto p-3">
                      <ProbeConnector disabled={flashing} />
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
