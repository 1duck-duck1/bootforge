import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Download, Eraser, LineChart, Pause, Play, Zap } from "lucide-react";
import { useLogStore } from "@/stores/logStore";
import type { TelemetryChartStore } from "@/stores/telemetryChartStore";
import { saveTextFile } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  computeSeriesStats,
  formatChartValue,
  formatClockTime,
  nearestPoint,
  type SeriesPoint,
} from "@/lib/rttChart";

const WINDOW_OPTIONS = [
  { value: 10, label: "最近 10 秒" },
  { value: 30, label: "最近 30 秒" },
  { value: 60, label: "最近 60 秒" },
  { value: 300, label: "最近 5 分钟" },
  { value: 0, label: "全部数据" },
];

const PADDING = { left: 58, right: 16, top: 14, bottom: 26 };
const MAX_RENDER_POINTS = 700;

function downsample(points: SeriesPoint[], limit = MAX_RENDER_POINTS): SeriesPoint[] {
  if (points.length <= limit) return points;
  const step = Math.ceil(points.length / limit);
  const sampled: SeriesPoint[] = [];
  for (let index = 0; index < points.length; index += step) {
    sampled.push(points[index]);
  }
  const last = points[points.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * 通用实时图表面板：RTT 与串口共用同一套渲染/统计/导出逻辑，
 * 通过传入各自的 store 与标题区分数据来源。
 */
export function TelemetryChartPanel({
  store,
  title,
  source,
  exportPrefix,
}: {
  store: TelemetryChartStore;
  title: string;
  /** 数据来源名称，用于提示文案：RTT / 串口 */
  source: string;
  exportPrefix: string;
}) {
  const series = store((s) => s.series);
  const paused = store((s) => s.paused);
  const enabled = store((s) => s.enabled);
  const windowSec = store((s) => s.windowSec);
  const parsedLines = store((s) => s.parsedLines);
  const setPaused = store((s) => s.setPaused);
  const setEnabled = store((s) => s.setEnabled);
  const setWindowSec = store((s) => s.setWindowSec);
  const clear = store((s) => s.clear);
  const toggleSeries = store((s) => s.toggleSeries);

  const chartRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 320 });
  const [now, setNow] = useState(() => Date.now());
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);

  useEffect(() => {
    const element = chartRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setSize({
        width: Math.max(280, Math.round(rect.width)),
        height: Math.max(200, Math.round(rect.height)),
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (windowSec === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [windowSec]);

  useEffect(() => {
    if (!hover) return;
    const timeout = window.setTimeout(() => setHover(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [hover]);

  const visibleSeries = useMemo(() => series.filter((item) => item.visible), [series]);

  const range = useMemo(() => {
    if (windowSec === 0) {
      let first = Number.POSITIVE_INFINITY;
      let last = Number.NEGATIVE_INFINITY;
      for (const item of visibleSeries) {
        if (item.points.length === 0) continue;
        first = Math.min(first, item.points[0].t);
        last = Math.max(last, item.points[item.points.length - 1].t);
      }
      if (!Number.isFinite(first) || !Number.isFinite(last)) {
        return { t0: now - 30_000, t1: now };
      }
      return last - first < 1000 ? { t0: first, t1: first + 1000 } : { t0: first, t1: last };
    }
    return { t0: now - windowSec * 1000, t1: now };
  }, [visibleSeries, windowSec, now]);

  const clipped = useMemo(
    () =>
      visibleSeries.map((item) => ({
        ...item,
        points: item.points.filter((point) => point.t >= range.t0 && point.t <= range.t1),
      })),
    [visibleSeries, range]
  );

  const yDomain = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let count = 0;
    for (const item of clipped) {
      for (const point of item.points) {
        if (point.v < min) min = point.v;
        if (point.v > max) max = point.v;
        count += 1;
      }
    }
    if (count === 0) return null;
    if (min === max) {
      const pad = Math.max(1, Math.abs(min) * 0.1);
      return { min: min - pad, max: max + pad };
    }
    const pad = (max - min) * 0.08;
    return { min: min - pad, max: max + pad };
  }, [clipped]);

  const plotWidth = Math.max(10, size.width - PADDING.left - PADDING.right);
  const plotHeight = Math.max(10, size.height - PADDING.top - PADDING.bottom);

  const xOf = (time: number) =>
    PADDING.left + ((time - range.t0) / Math.max(1, range.t1 - range.t0)) * plotWidth;
  const yOf = (value: number) =>
    PADDING.top +
    (1 - (value - (yDomain?.min ?? 0)) / Math.max(1e-9, (yDomain?.max ?? 1) - (yDomain?.min ?? 0))) *
      plotHeight;

  const yTicks = useMemo(() => {
    if (!yDomain) return [];
    return Array.from({ length: 5 }, (_, index) => {
      const value = yDomain.min + ((yDomain.max - yDomain.min) * index) / 4;
      return { value, y: yOf(value) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yDomain, size.height]);

  const xTicks = useMemo(
    () =>
      Array.from({ length: 5 }, (_, index) => {
        const time = range.t0 + ((range.t1 - range.t0) * index) / 4;
        return { time, x: xOf(time) };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, size.width]
  );

  const handleMove = (event: ReactMouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x < PADDING.left || x > PADDING.left + plotWidth) {
      setHover(null);
      return;
    }
    const ratio = (x - PADDING.left) / plotWidth;
    setHover({ x, time: range.t0 + ratio * (range.t1 - range.t0) });
  };

  const handleExport = async () => {
    const withData = series.filter((item) => item.points.length > 0);
    if (withData.length === 0) {
      useLogStore.getState().addLog("warn", "暂无图表数据可导出");
      return;
    }
    const stampDate = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${stampDate.getFullYear()}${pad(stampDate.getMonth() + 1)}${pad(
      stampDate.getDate()
    )}-${pad(stampDate.getHours())}${pad(stampDate.getMinutes())}${pad(stampDate.getSeconds())}`;
    const path = await save({
      title: `导出${title}数据`,
      defaultPath: `${exportPrefix}-${stamp}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (typeof path !== "string") return;

    const timestamps = Array.from(
      new Set(withData.flatMap((item) => item.points.map((point) => point.t)))
    ).sort((a, b) => a - b);
    const valueMaps = withData.map(
      (item) => new Map(item.points.map((point) => [point.t, point.v]))
    );
    const rows: string[][] = [
      ["timestamp", "iso_time", ...withData.map((item) => item.key)],
      ...timestamps.map((time) => [
        String(time),
        new Date(time).toISOString(),
        ...valueMaps.map((map) => {
          const value = map.get(time);
          return value === undefined ? "" : String(value);
        }),
      ]),
    ];

    try {
      await saveTextFile(path, rows.map((row) => row.map(csvEscape).join(",")).join("\n"));
      useLogStore
        .getState()
        .addLog("success", `${title}已导出: ${path}（${timestamps.length} 个时间点）`);
    } catch (error) {
      useLogStore.getState().addLog("error", `导出${title}失败: ${error}`);
    }
  };

  const hoverValues = useMemo(() => {
    if (!hover) return [];
    return clipped
      .map((item) => ({ item, point: nearestPoint(item.points, hover.time) }))
      .filter((entry): entry is { item: (typeof clipped)[number]; point: SeriesPoint } =>
        Boolean(entry.point)
      );
  }, [hover, clipped]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1.5 border-b px-2 py-1">
        <span className="flex items-center gap-1.5 pl-1 text-[11px]">
          <LineChart className="h-3.5 w-3.5 text-primary" />
          <span className="font-medium">{title}</span>
          <span className="text-muted-foreground">
            {parsedLines} 数据行 · {series.length} 通道
            {paused && <span className="ml-2 text-yellow-600 dark:text-yellow-500">已暂停采样</span>}
          </span>
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Select
            value={String(windowSec)}
            onChange={(event) => setWindowSec(Number(event.target.value))}
            className="h-7 w-28 text-[11px]"
            title="图表时间窗口"
          >
            {WINDOW_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Tooltip label={enabled ? `暂停解析 ${source} 数值` : `恢复解析 ${source} 数值`}>
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-7 w-7", !enabled && "text-muted-foreground")}
              onClick={() => setEnabled(!enabled)}
              aria-label="切换图表解析"
            >
              <Zap className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
          <Tooltip label={paused ? "恢复采样" : "暂停采样"}>
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-7 w-7", paused && "text-yellow-600 dark:text-yellow-500")}
              onClick={() => setPaused(!paused)}
              aria-label="暂停图表采样"
            >
              {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            </Button>
          </Tooltip>
          <Tooltip label="导出图表数据 CSV">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => void handleExport()}
              disabled={series.length === 0}
              aria-label="导出图表数据"
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
          <Tooltip label="清空图表数据">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={clear} aria-label="清空图表">
              <Eraser className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
        </div>
      </div>

      <div ref={chartRef} className="relative min-h-[220px] flex-1">
        {yDomain && clipped.length > 0 ? (
          <svg
            width={size.width}
            height={size.height}
            onMouseMove={handleMove}
            onMouseLeave={() => setHover(null)}
            className="block"
          >
            <rect
              x={PADDING.left}
              y={PADDING.top}
              width={plotWidth}
              height={plotHeight}
              className="fill-transparent stroke-border"
              strokeWidth={1}
            />
            {yTicks.map((tick) => (
              <g key={`y-${tick.value}`}>
                <line
                  x1={PADDING.left}
                  y1={tick.y}
                  x2={PADDING.left + plotWidth}
                  y2={tick.y}
                  className="stroke-border/50"
                  strokeDasharray="3 4"
                  strokeWidth={1}
                />
                <text
                  x={PADDING.left - 8}
                  y={tick.y + 3}
                  textAnchor="end"
                  className="fill-muted-foreground text-[10px]"
                >
                  {formatChartValue(tick.value)}
                </text>
              </g>
            ))}
            {xTicks.map((tick) => (
              <g key={`x-${tick.time}`}>
                <line
                  x1={tick.x}
                  y1={PADDING.top}
                  x2={tick.x}
                  y2={PADDING.top + plotHeight}
                  className="stroke-border/40"
                  strokeDasharray="3 4"
                  strokeWidth={1}
                />
                <text
                  x={tick.x}
                  y={PADDING.top + plotHeight + 16}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px]"
                >
                  {formatClockTime(tick.time)}
                </text>
              </g>
            ))}

            {clipped.map((item) => {
              const points = downsample(item.points);
              if (points.length === 0) return null;
              if (points.length === 1) {
                return (
                  <circle
                    key={item.key}
                    cx={xOf(points[0].t)}
                    cy={yOf(points[0].v)}
                    r={3}
                    fill={item.color}
                  />
                );
              }
              return (
                <polyline
                  key={item.key}
                  fill="none"
                  stroke={item.color}
                  strokeWidth={1.8}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  points={points
                    .map((point) => `${xOf(point.t).toFixed(1)},${yOf(point.v).toFixed(1)}`)
                    .join(" ")}
                />
              );
            })}

            {hover && (
              <line
                x1={hover.x}
                y1={PADDING.top}
                x2={hover.x}
                y2={PADDING.top + plotHeight}
                className="stroke-muted-foreground/60"
                strokeDasharray="4 3"
                strokeWidth={1}
              />
            )}
          </svg>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[11px] text-muted-foreground">
            <LineChart className="h-6 w-6 opacity-40" />
            {!enabled ? (
              <span>图表解析已关闭，点击工具栏闪电图标恢复</span>
            ) : series.length === 0 ? (
              <>
                <span>{source}输出以下格式会自动解析为图表：</span>
                <div className="terminal-font rounded-md border bg-muted/40 px-3 py-2 text-left leading-5">
                  <div>CH1: 25.6, CH2: 60.1</div>
                  <div>temp=25.6 humidity=60.1</div>
                  <div>1.23, 4.56, 7.89</div>
                  <div>{'{"temp": 25.6, "humidity": 60.1}'}</div>
                </div>
              </>
            ) : (
              <span>当前时间窗内没有样本，试试切换到“全部数据”</span>
            )}
          </div>
        )}

        {hover && hoverValues.length > 0 && (
          <div
            className="pointer-events-none absolute top-5 z-10 min-w-28 rounded-md border bg-card/95 px-2 py-1.5 text-[11px] shadow-md"
            style={{
              left: hover.x > size.width * 0.62 ? hover.x - 12 : hover.x + 12,
              transform: hover.x > size.width * 0.62 ? "translateX(-100%)" : undefined,
            }}
          >
            <div className="terminal-font mb-1 text-muted-foreground">
              {formatClockTime(hover.time, true)}
            </div>
            {hoverValues.map(({ item, point }) => (
              <div key={item.key} className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: item.color }} />
                <span className="text-muted-foreground">{item.label}</span>
                <span className="terminal-font ml-auto">{formatChartValue(point.v)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t">
        <div className="flex flex-wrap gap-1.5 px-2 py-1.5">
          {series.length === 0 && (
            <span className="text-[11px] text-muted-foreground">等待通道数据…</span>
          )}
          {series.map((item) => {
            const latest = item.points.length > 0 ? item.points[item.points.length - 1].v : null;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => toggleSeries(item.key)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                  item.visible
                    ? "bg-accent/60 text-foreground"
                    : "text-muted-foreground opacity-60 hover:opacity-100"
                )}
                title={item.visible ? "点击隐藏该通道" : "点击显示该通道"}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: item.color }} />
                <span>{item.label}</span>
                <span className="terminal-font">{latest === null ? "-" : formatChartValue(latest)}</span>
              </button>
            );
          })}
        </div>

        {clipped.length > 0 && (
          <div className="max-h-32 overflow-auto border-t">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-card text-muted-foreground">
                <tr className="border-b">
                  <th className="px-2 py-1 text-left font-medium">通道</th>
                  <th className="px-2 py-1 text-right font-medium">当前</th>
                  <th className="px-2 py-1 text-right font-medium">最小</th>
                  <th className="px-2 py-1 text-right font-medium">最大</th>
                  <th className="px-2 py-1 text-right font-medium">平均</th>
                  <th className="px-2 py-1 text-right font-medium">标准差</th>
                  <th className="px-2 py-1 text-right font-medium">样本</th>
                </tr>
              </thead>
              <tbody className="terminal-font">
                {clipped.map((item) => {
                  const stats = computeSeriesStats(item.points);
                  return (
                    <tr key={item.key} className="border-b border-border/40 last:border-0">
                      <td className="px-2 py-1">
                        <span className="flex items-center gap-1.5">
                          <span
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ background: item.color }}
                          />
                          {item.label}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-right">
                        {stats.latest === null ? "-" : formatChartValue(stats.latest)}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {stats.min === null ? "-" : formatChartValue(stats.min)}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {stats.max === null ? "-" : formatChartValue(stats.max)}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {stats.avg === null ? "-" : formatChartValue(stats.avg)}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {stats.std === null ? "-" : formatChartValue(stats.std)}
                      </td>
                      <td className="px-2 py-1 text-right">{stats.count}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
