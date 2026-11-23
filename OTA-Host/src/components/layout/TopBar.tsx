import { useState } from "react";
import { Moon, PanelRight, Settings, Sun } from "lucide-react";
import { WORKSPACE_BY_MODE } from "@/components/modes/workspaceRegistry";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { useAppStore } from "@/stores/appStore";
import { useSerialStore } from "@/stores/serialStore";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function TopBar({
  inspectorOpen,
  onToggleInspector,
}: {
  inspectorOpen: boolean;
  onToggleInspector: () => void;
}) {
  const mode = useAppStore((s) => s.mode);
  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const connected = useSerialStore((s) => s.connected);
  const port = useSerialStore((s) => s.form.port);
  const baud = useSerialStore((s) => s.form.baudRate);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const workspace = WORKSPACE_BY_MODE[mode];
  const HeaderIcon = workspace.navigationIcon;

  return (
    <header className="surface-card flex h-12 shrink-0 items-center gap-3 rounded-xl px-4">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <HeaderIcon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <h1 className="truncate text-sm font-semibold">{workspace.label}</h1>
      </div>

      <div className="ml-auto flex items-center gap-3">
        {/* 串口连接状态徽章 */}
        <div
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
            connected
              ? "border-success/40 bg-success/10 text-success"
              : "border-border bg-muted/50 text-muted-foreground"
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              connected ? "bg-success" : "bg-muted-foreground/60"
            )}
          />
          {connected ? `${port} @ ${baud}` : "串口未连接"}
        </div>

        {mode !== "ota" && (
          <Tooltip label={inspectorOpen ? "收起配置侧栏" : "展开配置侧栏"}>
            <Button variant="ghost" size="icon" onClick={onToggleInspector} aria-label="切换配置侧栏">
              <PanelRight className={cn("h-4 w-4", inspectorOpen && "text-primary")} />
            </Button>
          </Tooltip>
        )}

        <Tooltip label="设置（工具链 / 分区）">
          <Button variant="ghost" size="icon" onClick={() => setSettingsOpen(true)} aria-label="打开设置">
            <Settings className="h-4 w-4" />
          </Button>
        </Tooltip>

        <Tooltip label={theme === "dark" ? "切换亮色" : "切换暗色"}>
          <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="切换主题">
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </Tooltip>
      </div>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  );
}
