/** 字节数组转大写 HEX，默认空格分隔 */
export function toHex(bytes: number[], separator = " "): string {
  return bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(separator);
}

/**
 * 解析 HEX 输入：允许空格 / 逗号 / 分号 / 0x 前缀。
 * 返回 null 表示格式错误（奇数个字符或含非十六进制字符）。
 */
export function parseHexBytes(input: string): number[] | null {
  const compact = input
    .replace(/0x/gi, "")
    .split(/[\s,;]+/)
    .join("");
  if (!compact) return [];
  if (!/^[0-9a-fA-F]+$/.test(compact) || compact.length % 2 !== 0) return null;

  const bytes: number[] = [];
  for (let index = 0; index < compact.length; index += 2) {
    bytes.push(Number.parseInt(compact.slice(index, index + 2), 16));
  }
  return bytes;
}

/** 解析十六进制数值（地址等），失败返回 null */
export function parseHexNumber(input: string): number | null {
  const compact = input.trim().replace(/^0x/i, "").replace(/[\s_]/g, "");
  if (!compact || !/^[0-9a-fA-F]+$/.test(compact)) return null;
  const value = Number.parseInt(compact, 16);
  return Number.isSafeInteger(value) ? value : null;
}

/** 固定宽度大写 HEX，例如 0x08020000 */
export function formatHex(value: number, digits = 8): string {
  return `0x${value.toString(16).toUpperCase().padStart(digits, "0")}`;
}
