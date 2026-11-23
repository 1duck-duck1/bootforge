import { RttPanel } from "@/components/rtt/RttPanel";
import { LogPanel } from "@/components/log/LogPanel";

export function RttMode() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <RttPanel />
      </div>
      <LogPanel />
    </div>
  );
}
