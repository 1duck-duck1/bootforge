import { useRttStore } from "@/stores/rttStore";
import { RttToolbar } from "@/components/rtt/RttToolbar";
import { RttViewer } from "@/components/rtt/RttViewer";
import { RttChartPanel } from "@/components/rtt/RttChartPanel";
import { RttSendBar } from "@/components/rtt/RttSendBar";
import { RttStatusBar } from "@/components/rtt/RttStatusBar";
import { TelemetryWorkspace } from "@/components/telemetry/TelemetryWorkspace";

export function RttPanel() {
  const config = useRttStore((s) => s.config);
  const viewMode = useRttStore((s) => s.viewMode);
  const hasDownChannel = (config?.down_channels.length ?? 0) > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <RttToolbar />

      <TelemetryWorkspace viewMode={viewMode} text={<RttViewer />} chart={<RttChartPanel />} />

      {viewMode !== "chart" && hasDownChannel && <RttSendBar />}
      <RttStatusBar />
    </div>
  );
}
