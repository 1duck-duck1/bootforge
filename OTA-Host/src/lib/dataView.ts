/** 数据视图模式：文本 / 分屏（文本 + 图表）/ 图表，串口与 RTT 共用 */
export type DataViewMode = "text" | "split" | "chart";

/** 兼容旧版本持久化的 viewMode（"terminal" 迁移为 "text"） */
export function normalizeDataViewMode(value: unknown): DataViewMode | null {
  if (value === "text" || value === "split" || value === "chart") return value;
  if (value === "terminal") return "text";
  return null;
}
