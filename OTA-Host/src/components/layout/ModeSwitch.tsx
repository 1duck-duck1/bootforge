import { Tooltip } from "@/components/ui/tooltip";
import { WORKSPACE_REGISTRY } from "@/components/modes/workspaceRegistry";
import { useAppStore } from "@/stores/appStore";
import { cn } from "@/lib/utils";

export function ModeSwitch({
  orientation = "vertical",
  className,
}: {
  orientation?: "vertical" | "horizontal";
  className?: string;
}) {
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);

  return (
    <nav
      className={cn(
        "flex gap-1.5",
        orientation === "vertical" ? "flex-col" : "flex-row",
        className
      )}
      aria-label="工作台切换"
    >
      {WORKSPACE_REGISTRY.map((workspace, index) => {
        const Icon = workspace.navigationIcon;
        const active = mode === workspace.id;
        return (
          <Tooltip key={workspace.id} label={`${workspace.label} (Ctrl+${index + 1})`}>
            <button
              type="button"
              aria-label={workspace.label}
              aria-current={active ? "page" : undefined}
              onClick={() => setMode(workspace.id)}
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
                active
                  ? "bg-primary text-primary-foreground shadow-[0_4px_12px_hsl(var(--primary)/0.35)]"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )}
            >
              <Icon className="h-[18px] w-[18px]" />
            </button>
          </Tooltip>
        );
      })}
    </nav>
  );
}
