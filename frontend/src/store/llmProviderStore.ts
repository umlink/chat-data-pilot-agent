import { create } from 'zustand'
import { api } from '@/lib/api'
import type { LlmProvider, LlmProviderForm } from '@/types/llmProvider'

interface LlmProviderState {
  providers: LlmProvider[]
  loaded: boolean
  loadError: string
  load: () => Promise<void>
  create: (form: LlmProviderForm) => Promise<void>
  update: (id: string, form: Partial<LlmProviderForm>) => Promise<void>
  remove: (id: string) => Promise<void>
  setDefault: (id: string) => Promise<void>
}

/**
 * LLM 供应商状态（配置页与 Header 共享）。
 * 增删改后重新 load，保持「默认供应商」展示一致。
 */
export const useLlmProviderStore = create<LlmProviderState>((set, get) => ({
  providers: [],
  loaded: false,
  loadError: '',

  load: async () => {
    try {
      const providers = await api.get<LlmProvider[]>('/llm/providers')
      set({ providers, loaded: true, loadError: '' })
    } catch (e) {
      // 与空态区分：失败保留错误信息供页面展示「重试」，避免误导为「暂无供应商」
      set({ providers: [], loaded: true, loadError: e instanceof Error ? e.message : '供应商列表加载失败' })
    }
  },

  create: async (form) => {
    await api.post<LlmProvider>('/llm/providers', { ...form })
    await get().load()
  },

  update: async (id, form) => {
    await api.post<LlmProvider>('/llm/providers/update', { id, ...form })
    await get().load()
  },

  remove: async (id) => {
    await api.post('/llm/providers/delete', { id })
    await get().load()
  },

  setDefault: async (id) => {
    await api.post(`/llm/providers/${id}/set-default`)
    await get().load()
  },
}))
