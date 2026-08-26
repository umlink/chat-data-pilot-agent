import { useEffect } from 'react'
import { api } from '@/lib/api'
import { useConfigStore } from '@/store/configStore'
import type { ConfigMap } from '@/types/config'

/** 前端按 key 前缀分类（后端返回扁平 key→value，无 category 字段，见 docs/技术方案设计 2.3） */
function splitByCategory(cfg: ConfigMap) {
  const llm: Record<string, unknown> = {}
  const system: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(cfg)) {
    if (key.startsWith('llm.')) llm[key] = value
    else if (key.startsWith('system.')) system[key] = value
  }
  return { llm, system }
}

/** 配置管理页/对话前加载系统配置缓存。 */
export function useConfig() {
  const { setLlm, setSystem, setLoaded } = useConfigStore()

  useEffect(() => {
    void (async () => {
      try {
        const data = await api.get<ConfigMap>('/config')
        const { llm, system } = splitByCategory(data)
        setLlm(llm)
        setSystem(system)
        setLoaded(true)
      } catch {
        /* 后端未实现配置接口时静默 */
      }
    })()
  }, [setLlm, setSystem, setLoaded])
}