export const PHASE_LABELS: Record<string, string> = {
  idle: "待开始",
  connecting: "连接串口",
  enter: "进入 Boot",
  query: "查询设备",
  start: "擦除副槽",
  data: "写入镜像",
  end: "校验镜像",
  apply: "触发升级",
  verify: "回连校验",
  complete: "完成",
  cancelled: "已取消",
  error: "失败",
};

export const OTA_STEPS = ["连接", "Boot", "查询", "擦除", "写入", "校验", "APPLY", "回连"];
