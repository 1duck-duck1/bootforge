import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { nextSerialLineId, useSerialStore, type SerialLine } from "@/stores/serialStore";
import { useSerialChartStore } from "@/stores/serialChartStore";
import type { SerialDataEvent, SerialStatusEvent } from "@/lib/tauri";
import { useLogStore } from "@/stores/logStore";

/**
 * 监听后端串口事件：
 * - serial-data：RX 字节块 → 按字节级 \n 分行，保留原始 bytes 供 HEX 显示/导出，
 *   250ms 空闲刷出残留半行，rAF 批量提交 store
 * - serial-status：连接/运行/错误状态一次性应用
 */
export function useSerialEvents() {
  const addLines = useSerialStore((s) => s.addLines);

  // 行缓冲：跨 chunk 的半行数据（字节级，保证 HEX 模式不丢信息）
  const pendingRef = useRef<{ bytes: number[]; timestamp: number } | null>(null);
  // 批量提交缓冲：rAF 节流
  const batchRef = useRef<SerialLine[]>([]);
  const rafRef = useRef<number | null>(null);
  const idleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const decode = (bytes: number[]): string =>
      new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));

    const flushPending = () => {
      idleTimerRef.current = null;
      const pending = pendingRef.current;
      if (pending && pending.bytes.length > 0) {
        batchRef.current.push({
          id: 0,
          text: decode(pending.bytes),
          bytes: pending.bytes,
          timestamp: pending.timestamp,
          direction: "rx",
        });
        pendingRef.current = null;
        scheduleCommit();
      }
    };

    const scheduleIdleFlush = () => {
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(flushPending, 250);
    };

    // 暂停显示期间接收到的行先暂存，恢复后一次性补上
    const pausedBuffer: SerialLine[] = [];
    const flushPaused = () => {
      if (pausedBuffer.length === 0) return;
      const buffered = pausedBuffer.splice(0, pausedBuffer.length);
      addLines(buffered.map((line) => ({ ...line, id: nextSerialLineId() })));
    };

    const scheduleCommit = () => {
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          const batch = batchRef.current;
          batchRef.current = [];
          if (batch.length === 0) return;
          // 图表解析先行：终端暂停只影响日志显示，不影响数据采样
          useSerialChartStore.getState().ingest(batch);
          if (useSerialStore.getState().paused) {
            pausedBuffer.push(...batch);
            if (pausedBuffer.length > 5000) {
              pausedBuffer.splice(0, pausedBuffer.length - 5000);
            }
            return;
          }
          addLines(batch.map((line) => ({ ...line, id: nextSerialLineId() })));
        });
      }
    };

    const unsubscribePaused = useSerialStore.subscribe((state, previous) => {
      if (previous.paused && !state.paused) {
        flushPaused();
      }
    });

    const unlistenData = listen<SerialDataEvent>("serial-data", (event) => {
      const incoming: number[] = [];
      let timestamp = 0;
      for (const chunk of event.payload.chunks) {
        incoming.push(...chunk.data);
        timestamp = chunk.timestamp;
      }
      if (incoming.length === 0) return;

      const bytes = pendingRef.current
        ? pendingRef.current.bytes.concat(incoming)
        : incoming;

      // 按字节 0x0A 分行；行尾 0x0D 归一到 \r\n 语义后去掉
      let start = 0;
      for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] !== 0x0a) continue;
        const segment = bytes.slice(start, index);
        if (segment.length > 0 && segment[segment.length - 1] === 0x0d) {
          segment.pop();
        }
        if (segment.length > 0) {
          batchRef.current.push({
            id: 0,
            text: decode(segment),
            bytes: segment,
            timestamp,
            direction: "rx",
          });
        }
        start = index + 1;
      }

      const tail = bytes.slice(start);
      pendingRef.current = tail.length > 0 ? { bytes: tail, timestamp } : null;

      if (batchRef.current.length > 0 || pendingRef.current) {
        scheduleCommit();
        scheduleIdleFlush();
      }
    });

    const unlistenStatus = listen<SerialStatusEvent>("serial-status", (event) => {
      const { connected, running, error } = event.payload;
      // 停止时把残留半行刷出来
      if (!running && pendingRef.current) {
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (pending.bytes.length > 0) {
          const line: SerialLine = {
            id: nextSerialLineId(),
            text: decode(pending.bytes),
            bytes: pending.bytes,
            timestamp: pending.timestamp,
            direction: "rx",
          };
          useSerialChartStore.getState().ingest([line]);
          addLines([line]);
        }
      }
      useSerialStore.getState().applyStatus(connected, running, error);
      if (error) {
        useLogStore.getState().addLog("error", `串口异常: ${error}`);
      }
    });

    return () => {
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      unsubscribePaused();
      unlistenData.then((fn) => fn());
      unlistenStatus.then((fn) => fn());
    };
  }, [addLines]);
}
