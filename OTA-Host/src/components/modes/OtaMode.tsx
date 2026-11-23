import { SignPanel } from "@/components/ota/SignPanel";
import { FlashPanel } from "@/components/ota/FlashPanel";
import { SlotStatusPanel } from "@/components/ota/SlotStatusPanel";
import { UpgradeGuide } from "@/components/ota/UpgradeGuide";

export function OtaMode() {
  return (
    <div className="grid h-full min-h-0 grid-cols-2 gap-2 p-2">
      <div className="surface-card min-h-0 overflow-hidden rounded-xl">
        <SignPanel />
      </div>
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto pr-0.5">
        {/* 烧录（流程第 2 步） */}
        <FlashPanel />
        {/* 设备双槽状态 */}
        <SlotStatusPanel />
        {/* 一键升级 + 指引 + 手动触发 */}
        <div className="surface-card min-h-[340px] flex-1 overflow-hidden rounded-xl">
          <UpgradeGuide />
        </div>
      </div>
    </div>
  );
}
