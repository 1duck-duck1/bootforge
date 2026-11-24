import { useRttChartStore } from "@/stores/rttChartStore";
import { TelemetryChartPanel } from "@/components/charts/TelemetryChartPanel";

export function RttChartPanel() {
  return (
    <TelemetryChartPanel
      store={useRttChartStore}
      title="RTT 图表"
      source="RTT"
      exportPrefix="rtt-chart"
    />
  );
}
