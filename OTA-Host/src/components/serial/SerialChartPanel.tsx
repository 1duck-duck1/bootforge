import { useSerialChartStore } from "@/stores/serialChartStore";
import { TelemetryChartPanel } from "@/components/charts/TelemetryChartPanel";

export function SerialChartPanel() {
  return (
    <TelemetryChartPanel
      store={useSerialChartStore}
      title="串口图表"
      source="串口"
      exportPrefix="serial-chart"
    />
  );
}
