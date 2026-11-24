import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { nextRttLineId, useRttStore, type RttLine } from "@/stores/rttStore";
import { useRttChartStore } from "@/stores/rttChartStore";
import type { RttDataEvent, RttStatusEvent } from "@/lib/tauri";
import { useLogStore } from "@/stores/logStore";

/** 单个通道的半行缓冲 */
interface ChannelPending {
  bytes: number[];
  timestamp: number;
  lastAt: number;
}

const MAX_PENDING_BYTES = 16 * 1024;
const IDLE_FLUSH_MS = 200;

function decodeBase64(input: string): number[] {
  const binary = atob(input);
  const bytes = new Array<number>(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * 监听后端 RTT 事件：
 * - rtt-data：base64 字节块按通道累积，按 \n 分行；无换行的输出在空闲 200ms 后刷出
 * - rtt-status：附着/重连/停止/错误状态
 * 与串口一致：原始 bytes 保留，rAF 批量提交，暂停时暂存到恢复后一次性追加。
 */
export function useRttEvents() {
  const addLines = useRttStore((s) => s.addLines);
  const pausedBufferRef = useRef<RttLine[]>([]);

  useEffect(() => {
    const decode = (bytes: number[]): string =>
      new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));

    const pendingByChannel = new Map<number, ChannelPending>();
    const batch: RttLine[] = [];
    let raf: number | null = null;
    let disposed = false;

    const pushLine = (channel: number, bytes: number[], timestamp: number) => {
      if (bytes.length === 0) return;
      batch.push({
        id: 0,
        channel,
        text: decode(bytes),
        bytes,
        timestamp,
        direction: "rx",
      });
    };

    const commit = () => {
      raf = null;
      if (batch.length === 0) return;
      const lines = batch.splice(0, batch.length);
      useRttChartStore.getState().ingest(lines);
      if (useRttStore.getState().paused) {
        pausedBufferRef.current.push(...lines);
        if (pausedBufferRef.current.length > 5000) {
          pausedBufferRef.current.splice(0, pausedBufferRef.current.length - 5000);
        }
        return;
      }
      addLines(lines.map((line) => ({ ...line, id: nextRttLineId() })));
    };

    const scheduleCommit = () => {
      if (raf === null && !disposed) {
        raf = requestAnimationFrame(commit);
      }
    };

    const flushChannel = (channel: number) => {
      const pending = pendingByChannel.get(channel);
      if (!pending) return;
      pendingByChannel.delete(channel);
      pushLine(channel, pending.bytes, pending.timestamp);
    };

    const flushAll = () => {
      for (const channel of Array.from(pendingByChannel.keys())) {
        flushChannel(channel);
      }
      scheduleCommit();
    };

    const unlistenData = listen<RttDataEvent>("rtt-data", (event) => {
      if (event.payload.chunks.length === 0) return;

      for (const chunk of event.payload.chunks) {
        const incoming = decodeBase64(chunk.data);
        const pending = pendingByChannel.get(chunk.channel);
        const bytes = pending ? pending.bytes.concat(incoming) : incoming;

        let start = 0;
        for (let index = 0; index < bytes.length; index += 1) {
          if (bytes[index] !== 0x0a) continue;
          const segment = bytes.slice(start, index);
          if (segment.length > 0 && segment[segment.length - 1] === 0x0d) {
            segment.pop();
          }
          pushLine(chunk.channel, segment, chunk.timestamp);
          start = index + 1;
        }

        const tail = bytes.slice(start);
        if (tail.length === 0) {
          pendingByChannel.delete(chunk.channel);
        } else if (tail.length > MAX_PENDING_BYTES) {
          // 目标持续输出且不含换行：强制断行，避免缓冲无限增长
          pushLine(chunk.channel, tail, chunk.timestamp);
          pendingByChannel.delete(chunk.channel);
        } else {
          pendingByChannel.set(chunk.channel, {
            bytes: tail,
            timestamp: chunk.timestamp,
            lastAt: Date.now(),
          });
        }
      }

      scheduleCommit();
    });

    // 无换行输出（例如进度打印）按空闲时间断行
    const idleTimer = window.setInterval(() => {
      const now = Date.now();
      let dirty = false;
      for (const [channel, pending] of Array.from(pendingByChannel.entries())) {
        if (now - pending.lastAt < IDLE_FLUSH_MS) continue;
        pendingByChannel.delete(channel);
        pushLine(channel, pending.bytes, pending.timestamp);
        dirty = true;
      }
      if (dirty) scheduleCommit();
    }, 120);

    const unlistenStatus = listen<RttStatusEvent>("rtt-status", (event) => {
      const payload = event.payload;
      const addLog = useLogStore.getState().addLog;

      if (!payload.running) {
        flushAll();
      }
      useRttStore.getState().applyStatus(payload);

      if (payload.error) {
        addLog("error", `RTT: ${payload.error}`);
      } else if (!payload.running) {
        addLog("info", "RTT 已停止");
      } else if (payload.attached && payload.config) {
        addLog(
          "success",
          `RTT 控制块已附着 @ 0x${payload.config.control_block_address.toString(16).toUpperCase()}`
        );
      }
    });

    // 恢复显示时把暂停期间积压的行一次性补上
    const unsubscribePaused = useRttStore.subscribe((state, previous) => {
      if (previous.paused && !state.paused && pausedBufferRef.current.length > 0) {
        // 这些行在 commit 时已送入图表，恢复显示只需补终端
        const buffered = pausedBufferRef.current.splice(0);
        addLines(buffered.map((line) => ({ ...line, id: nextRttLineId() })));
      }
    });

    return () => {
      disposed = true;
      if (raf !== null) cancelAnimationFrame(raf);
      clearInterval(idleTimer);
      unsubscribePaused();
      unlistenData.then((fn) => fn());
      unlistenStatus.then((fn) => fn());
    };
  }, [addLines]);
}
