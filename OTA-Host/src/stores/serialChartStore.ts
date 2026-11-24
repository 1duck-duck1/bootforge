import { parseRttChartLine } from "@/lib/rttChart";
import { createTelemetryChartStore } from "./telemetryChartStore";

export type { TelemetryChartSeries as SerialChartSeries } from "./telemetryChartStore";

/** 串口 RX 数值解析出的图表数据（与 RTT 图表彼此独立） */
export const useSerialChartStore = createTelemetryChartStore(parseRttChartLine);
