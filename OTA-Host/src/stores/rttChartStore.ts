import { parseRttChartLine } from "@/lib/rttChart";
import { createTelemetryChartStore } from "./telemetryChartStore";

export type { TelemetryChartSeries as RttChartSeries } from "./telemetryChartStore";

/** RTT 输出数值解析出的图表数据 */
export const useRttChartStore = createTelemetryChartStore(parseRttChartLine);
