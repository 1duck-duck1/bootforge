/** 烧录阶段英文名 → 中文标签，与后端 flash-progress 事件的 phase 对齐 */
export const PHASE_LABELS: Record<string, string> = {
  init: "准备",
  preverify: "预校验",
  erase: "擦除",
  program: "编程",
  verify: "校验",
  fill: "填充",
  finishing: "收尾",
  reset: "复位",
  complete: "完成",
  info: "信息",
  error: "失败",
};
