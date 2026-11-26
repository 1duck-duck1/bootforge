import { SignPanel } from "@/components/ota/SignPanel";
import { SerialOtaPanel } from "@/components/ota/SerialOtaPanel";
import { SlotStatusPanel } from "@/components/ota/SlotStatusPanel";

export function OtaMode() {
  return (
    <div className="grid h-full min-h-0 grid-cols-2 gap-2 p-2">
      <div className="surface-card min-h-0 overflow-hidden rounded-xl">
        <SignPanel />
      </div>
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto pr-0.5">
        {/* 串口 OTA（无需探针，主升级路径） */}
        <SerialOtaPanel />
        {/* 设备双槽状态（需探针） */}
        <SlotStatusPanel />
      </div>
    </div>
  );
}
