import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AppMode = "serial" | "ota" | "rtt" | "flash";
export type ThemeMode = "dark" | "light";

interface AppStore {
  mode: AppMode;
  theme: ThemeMode;
  setMode: (mode: AppMode) => void;
  toggleTheme: () => void;
}

export const useAppStore = create<AppStore>()(
  persist(
    (set) => ({
      mode: "serial",
      theme: "dark",
      setMode: (mode) => set({ mode }),
      toggleTheme: () => set((s) => ({ theme: s.theme === "dark" ? "light" : "dark" })),
    }),
    { name: "ota-host-app" }
  )
);
