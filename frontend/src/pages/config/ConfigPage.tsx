import { useCallback, useEffect, useState } from 'react'
import { Save } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import type { ConfigMap, ConfigValue, LogEntry, LogsPage } from '@/types/config'
import { MASKED } from '@/types/config'
import { LlmProvidersTab } from './LlmProvidersTab'
import { SystemConfigTab, makeSystemKeys } from './SystemConfigTab'
import { ConfigCard } from './FormKit'

/** 时间格式化：与其它列表一致的 'YYYY-MM-DD HH:mm:ss' 展示，避免裸渲染 ISO */
function formatTime(value?: string | null): string {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 配置管理页：LLM / 系统双 tab + 最近审计日志（docs/技术方案设计 2.3 配置 API / 3.6 页面） */
export function ConfigPage() {
  const [config, setConfig] = useState<ConfigMap | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [logsError, setLogsError] = useState('')

  const loadLogs = useCallback(async () => {
    try {
      const page = await api.get<LogsPage>('/logs?category=audit&page=1&page_size=5')
      setLogs(page.items ?? [])
      setLogsError('')
    } catch (e) {
      // 加载失败展示可读错误 + 重试，不静默当空数据处理
      setLogsError(e instanceof Error ? e.message : '审计日志加载失败')
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const data = await api.get<ConfigMap>('/config')
        setConfig(data)
        setDirty(false)
      } catch (e) {
        setNotice(e instanceof Error ? e.message : '配置加载失败')
        setConfig({})
      }
    })()
    void loadLogs()
  }, [loadLogs])

  const setField = (key: string, field: string, value: unknown) => {
    setConfig((prev) => {
      const cur = prev?.[key] ?? {}
      return { ...(prev ?? {}), [key]: { ...cur, [field]: value } }
    })
    setDirty(true)
    setNotice('')
  }

  const save = async (keys: string[]) => {
    if (!config) return
    // 字段级提交：MASKED / 空串跳过（= 保留旧值；后端 upsert_secret 语义）
    const updates: Record<string, ConfigValue> = {}
    for (const key of keys) {
      const value = config[key] ?? {}
      const filtered: ConfigValue = {}
      for (const [field, v] of Object.entries(value)) {
        if (v === MASKED || v === '') continue
        filtered[field] = v
      }
      if (Object.keys(filtered).length > 0) updates[key] = filtered
    }
    setSaving(true)
    try {
      const data = await api.post<ConfigMap>('/config/update', { updates })
      setConfig(data)
      setDirty(false)
      setNotice('已保存')
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (!config) {
    return (
      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-6 pb-1 pt-6">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground">配置管理</h2>
          <p className="text-xs text-muted-foreground">LLM 与系统运行参数；密钥加密存储，对外仅显示掩码</p>
        </div>
        <div className="flex items-center gap-3">
          {notice && (
            <span className={notice === '已保存' ? 'text-[13px] text-success' : 'text-[13px] text-error'}>
              {notice}
            </span>
          )}
          <Button
            size="sm"
            disabled={saving || !dirty}
            onClick={() => void save(['llm.provider', ...makeSystemKeys()])}
          >
            <Save size={14} /> {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>

      <div className="flex-1 px-6 pb-6">
        <Tabs defaultValue="llm">
          <TabsList>
            <TabsTrigger value="llm">LLM 供应商</TabsTrigger>
            <TabsTrigger value="system">系统配置</TabsTrigger>
          </TabsList>
          <TabsContent value="llm" className="mt-4">
            <LlmProvidersTab config={config} setField={setField} />
          </TabsContent>
          <TabsContent value="system" className="mt-4">
            <SystemConfigTab config={config} setField={setField} />
          </TabsContent>
        </Tabs>

        <ConfigCard className="mt-4" title="最近审计日志" hint="配置变更、任务执行等关键操作（GET /api/logs?category=audit）">
          {logsError ? (
            <div className="flex items-center justify-between rounded-lg border border-error/30 bg-error-bg px-4 py-3">
              <p className="text-xs text-error">{logsError}</p>
              <Button variant="outline" size="sm" onClick={() => void loadLogs()}>
                重试
              </Button>
            </div>
          ) : logs.length === 0 ? (
            <p className="py-4 text-center text-[13px] text-muted-foreground">暂无审计记录</p>
          ) : (
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted">
                    <th className="border-b px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">时间</th>
                    <th className="border-b px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">用户</th>
                    <th className="border-b px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">操作</th>
                    <th className="border-b px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">详情</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((l) => {
                    const ctx = l.context ?? {}
                    return (
                      <tr key={l.id ?? String(l.timestamp)} className="border-b last:border-b-0 text-foreground">
                        <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                          {formatTime(l.timestamp)}
                        </td>
                        <td className="px-3 py-2">{String(ctx.user ?? '-')}</td>
                        <td className="px-3 py-2">
                          {String(ctx.resource ?? l.category)} · {String(ctx.action ?? '-')}
                        </td>
                        <td className="max-w-[320px] truncate px-3 py-2 text-muted-foreground" title={l.message}>
                          {l.message}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </ConfigCard>
      </div>
    </div>
  )
}
