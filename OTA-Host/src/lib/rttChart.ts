/**
 * RTT 图表数据解析。
 *
 * 支持的行格式（自动识别，优先级从上到下）：
 *   {"temp": 25.6, "humidity": 60.1}      JSON 对象
 *   temp=25.6 humidity=60.1 / TEMP: 25.6  键值对
 *   1.23, 4.56, 7.89                      纯数值（自动命名 CH1..CHn）
 *
 * 十六进制数（0x...）会被剔除，避免日志里的地址被误识别为通道。
 */

export interface ParsedChannelValue {
  key: string;
  label: string;
  value: number;
}

export interface SeriesPoint {
  /** Unix 毫秒时间戳 */
  t: number;
  v: number;
}

export interface SeriesStats {
  latest: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
  std: number | null;
  count: number;
}

export const CHART_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
  "#f97316",
  "#6366f1",
  "#14b8a6",
  "#eab308",
];

const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;
const HEX_TOKEN = /\b0x[0-9a-fA-F]+\b/g;
const KV_PATTERN =
  /([A-Za-z_][A-Za-z0-9_.-]{0,23})\s*[:=]\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/g;
const NUMBER_TOKEN = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const MAX_CHANNELS_PER_LINE = 12;

export function parseRttChartLine(raw: string): ParsedChannelValue[] | null {
  const text = raw.replace(ANSI_ESCAPE, "").trim();
  if (!text) return null;

  if (text.startsWith("{") && text.endsWith("}")) {
    const jsonValues = parseJsonLine(text);
    if (jsonValues) return jsonValues;
  }

  const sanitized = text.replace(HEX_TOKEN, " ");

  const keyValues: ParsedChannelValue[] = [];
  for (const match of sanitized.matchAll(KV_PATTERN)) {
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    keyValues.push({ key: match[1], label: match[1], value });
    if (keyValues.length >= MAX_CHANNELS_PER_LINE) break;
  }
  if (keyValues.length > 0) return keyValues;

  const tokens = sanitized.split(/[\s,;|]+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > MAX_CHANNELS_PER_LINE) return null;
  if (!tokens.every((token) => NUMBER_TOKEN.test(token))) return null;

  return tokens.map((token, index) => ({
    key: `CH${index + 1}`,
    label: `CH${index + 1}`,
    value: Number(token),
  }));
}

function parseJsonLine(text: string): ParsedChannelValue[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const values: ParsedChannelValue[] = [];
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      values.push({ key, label: key, value });
      if (values.length >= MAX_CHANNELS_PER_LINE) break;
    }
    return values.length > 0 ? values : null;
  } catch {
    return null;
  }
}

export function computeSeriesStats(points: SeriesPoint[]): SeriesStats {
  if (points.length === 0) {
    return { latest: null, min: null, max: null, avg: null, std: null, count: 0 };
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (const point of points) {
    if (point.v < min) min = point.v;
    if (point.v > max) max = point.v;
    sum += point.v;
  }
  const avg = sum / points.length;
  let variance = 0;
  for (const point of points) {
    variance += (point.v - avg) ** 2;
  }
  return {
    latest: points[points.length - 1].v,
    min,
    max,
    avg,
    std: Math.sqrt(variance / points.length),
    count: points.length,
  };
}

export function nearestPoint(points: SeriesPoint[], t: number): SeriesPoint | null {
  if (points.length === 0) return null;
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (points[mid].t < t) low = mid + 1;
    else high = mid;
  }
  const right = points[low];
  const left = points[Math.max(0, low - 1)];
  return Math.abs(left.t - t) <= Math.abs(right.t - t) ? left : right;
}

export function formatChartValue(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e6 || abs < 1e-3)) return value.toExponential(2);
  if (Number.isInteger(value)) return value.toString();
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  return value.toFixed(3);
}

export function formatClockTime(ms: number, withMillis = false): string {
  const date = new Date(ms);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const base = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return withMillis ? `${base}.${pad(date.getMilliseconds(), 3)}` : base;
}
