import { useRttStore } from "@/stores/rttStore";
import { RttToolbar } from "@/components/rtt/RttToolbar";
import { RttViewer } from "@/components/rtt/RttViewer";
import { RttSendBar } from "@/components/rtt/RttSendBar";
import { RttStatusBar } from "@/components/rtt/RttStatusBar";

export function RttPanel() {
  const config = useRttStore((s) => s.config);
  const hasDownChannel = (config?.down_channels.length ?? 0) > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <RttToolbar />
      <RttViewer />
      {hasDownChannel && <RttSendBar />}
      <RttStatusBar />
    </div>
  );
}
