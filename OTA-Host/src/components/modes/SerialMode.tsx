import { useState } from "react";
import { SerialToolbar } from "@/components/serial/SerialToolbar";
import { SerialViewer } from "@/components/serial/SerialViewer";
import { SerialSendBar } from "@/components/serial/SerialSendBar";
import { LogPanel } from "@/components/log/LogPanel";
import { useSerialStore } from "@/stores/serialStore";

export function SerialMode() {
  const splitView = useSerialStore((s) => s.splitView);
  const [query, setQuery] = useState("");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SerialToolbar query={query} onQueryChange={setQuery} />

      <div className="min-h-0 flex-1">
        {splitView ? (
          <div className="grid h-full min-h-0 grid-cols-2 divide-x">
            <SerialViewer query={query} direction="rx" label="RX · 接收" />
            <SerialViewer query={query} direction="tx" label="TX · 发送" />
          </div>
        ) : (
          <SerialViewer query={query} />
        )}
      </div>

      <SerialSendBar />
      <LogPanel />
    </div>
  );
}
