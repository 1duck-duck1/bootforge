import { create } from "zustand";

export type LogLevel = "info" | "success" | "warn" | "error";

export interface LogEntry {
  id: number;
  level: LogLevel;
  message: string;
  timestamp: number;
}

const MAX_ENTRIES = 500;
let nextId = 1;

interface LogStore {
  entries: LogEntry[];
  addLog: (level: LogLevel, message: string) => void;
  clear: () => void;
}

export const useLogStore = create<LogStore>((set) => ({
  entries: [],
  addLog: (level, message) =>
    set((state) => ({
      entries: [
        ...state.entries.slice(-MAX_ENTRIES + 1),
        { id: nextId++, level, message, timestamp: Date.now() },
      ],
    })),
  clear: () => set({ entries: [] }),
}));
