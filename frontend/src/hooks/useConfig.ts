import { useEffect } from 'react'
import { api } from '@/lib/api'
import { useConfigStore } from '@/store/configStore'

/** 配置管理页/对话前加载系统配置缓存。 */
export function useConfig() {
  const { setLlm, setSystem, setLoaded } = useConfigStore()

  useEffect(() => {
    void (async () => {
      try {
        const data = await api.get<Record<string, { category?: string; value?: Record<string, unknown> }>>('/config')
        const llm: Record<string, unknown> = {}
        const system: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(data)) {
          if (item?.category === 'llm') llm[key] = item.value
          else if (item?.category === 'system') system[key] = item.value
        }
        setLlm(llm)
        setSystem(system)
        setLoaded(true)
      } catch {
        /* 后端未实现配置接口时静默 */
      }
    })()
  }, [setLlm, setSystem, setLoaded])
}