import { create } from 'zustand'

interface ConfigState {
  llm: Record<string, unknown>
  system: Record<string, unknown>
  loaded: boolean
  setLlm: (llm: Record<string, unknown>) => void
  setSystem: (system: Record<string, unknown>) => void
  setLoaded: (v: boolean) => void
}

export const useConfigStore = create<ConfigState>((set) => ({
  llm: {},
  system: {},
  loaded: false,
  setLlm: (llm) => set({ llm }),
  setSystem: (system) => set({ system }),
  setLoaded: (loaded) => set({ loaded }),
}))