import { LogPanel } from "@/components/log/LogPanel";
import { SerialOtaPanel } from "@/components/ota/SerialOtaPanel";
import { SerialOtaToolbar } from "@/components/ota/SerialOtaToolbar";

export function OtaMode() {
  return (
    <div className="surface-strong relative flex h-full min-h-0 flex-col gap-2 overflow-hidden rounded-[14px] p-2">
      <SerialOtaToolbar />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="p-2">
          <SerialOtaPanel />
        </div>
      </div>
      <LogPanel className="mx-0 mb-0" />
    </div>
  );
}
