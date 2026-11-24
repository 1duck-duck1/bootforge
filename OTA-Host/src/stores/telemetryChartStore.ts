import { create, type StoreApi, type UseBoundStore } from "zustand";
import {
  CHART_COLORS,
  type ParsedChannelValue,
  type SeriesPoint,
} from "@/lib/rttChart";

/** 单通道最多保留的样本数 */
const MAX_POINTS = 3000;
/** 最多同时绘制的通道数 */
const MAX_SERIES = 12;

/** 图表只需要行的文本、时间戳与收发方向 */
export interface TelemetryChartLine {
  text: string;
  timestamp: number;
  direction: string;
}

export interface TelemetryChartSeries {
  key: string;
  label: string;
  color: string;
  visible: boolean;
  points: SeriesPoint[];
}

export interface TelemetryChartState {
  /** 是否解析输出 */
  enabled: boolean;
  /** 暂停接收新样本（终端不受影响） */
  paused: boolean;
  /** 展示窗口（秒），0 表示全部 */
  windowSec: number;
  series: TelemetryChartSeries[];
  parsedLines: number;
  parseFailures: number;

  ingest: (lines: TelemetryChartLine[]) => void;
  clear: () => void;
  setEnabled: (enabled: boolean) => void;
  setPaused: (paused: boolean) => void;
  setWindowSec: (windowSec: number) => void;
  toggleSeries: (key: string) => void;
}

export type TelemetryChartStore = UseBoundStore<StoreApi<TelemetryChartState>>;

type LineParser = (raw: string) => ParsedChannelValue[] | null;

/** 生成一份独立的图表 store：RTT 与串口各持有一份，互不影响 */
export function createTelemetryChartStore(parseLine: LineParser): TelemetryChartStore {
  return create<TelemetryChartState>()((set, get) => ({
    enabled: true,
    paused: false,
    windowSec: 30,
    series: [],
    parsedLines: 0,
    parseFailures: 0,

    ingest: (lines) => {
      const { enabled, paused } = get();
      if (!enabled || paused || lines.length === 0) return;

      const bucket = new Map<string, { label: string; points: SeriesPoint[] }>();
      let parsedLines = 0;
      let parseFailures = 0;

      for (const line of lines) {
        if (line.direction !== "rx" || !line.text) continue;
        const values = parseLine(line.text);
        if (!values) {
          parseFailures += 1;
          continue;
        }
        parsedLines += 1;
        for (const value of values) {
          let entry = bucket.get(value.key);
          if (!entry) {
            entry = { label: value.label, points: [] };
            bucket.set(value.key, entry);
          }
          entry.points.push({ t: line.timestamp, v: value.value });
        }
      }

      if (bucket.size === 0) {
        if (parseFailures > 0) {
          set((state) => ({ parseFailures: state.parseFailures + parseFailures }));
        }
        return;
      }

      set((state) => {
        const series = state.series.map((item) => ({ ...item }));
        const byKey = new Map(series.map((item) => [item.key, item]));

        for (const [key, entry] of bucket) {
          let target = byKey.get(key);
          if (!target) {
            if (series.length >= MAX_SERIES) continue;
            target = {
              key,
              label: entry.label,
              color: CHART_COLORS[series.length % CHART_COLORS.length],
              visible: true,
              points: [],
            };
            series.push(target);
            byKey.set(key, target);
          }
          target.points = [...target.points, ...entry.points].slice(-MAX_POINTS);
        }

        return {
          series,
          parsedLines: state.parsedLines + parsedLines,
          parseFailures: state.parseFailures + parseFailures,
        };
      });
    },

    clear: () => set({ series: [], parsedLines: 0, parseFailures: 0 }),
    setEnabled: (enabled) => set({ enabled }),
    setPaused: (paused) => set({ paused }),
    setWindowSec: (windowSec) => set({ windowSec }),
    toggleSeries: (key) =>
      set((state) => ({
        series: state.series.map((item) =>
          item.key === key ? { ...item, visible: !item.visible } : item
        ),
      })),
  }));
}
