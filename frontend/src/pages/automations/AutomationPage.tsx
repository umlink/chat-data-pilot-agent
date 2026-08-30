import { useCallback, useEffect, useState } from 'react'
import { CalendarClock, History, Play, Plus, Sparkles, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import type { DataSourceInfo } from '@/store/dataSourceStore'
import type { ChannelInfo } from '@/types/notification'
import type { AutomationInfo } from '@/types/automation'
import { AutomationFormDialog } from './AutomationFormDialog'
import { AutomationParseDialog } from './AutomationParseDialog'
import { AutomationRunsDialog } from './AutomationRunsDialog'

function formatTime(value?: string | null): string {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const LAST_STATUS = {
  success: { label: '成功', dot: 'succeeded', text: 'text-success' },
  failed: { label: '失败', dot: 'failed', text: 'text-error' },
  running: { label: '运行中', dot: 'running', text: 'text-info' },
} as const

/** 定时任务管理页：列表（计划/状态/下次运行）+ 新建/智能解析/编辑/启停/立即运行/历史/删除。 */
export function AutomationPage() {
  const [list, setList] = useState<AutomationInfo[] | null>(null)
  const [datasources, setDatasources] = useState<DataSourceInfo[]>([])
  const [channels, setChannels] = useState<ChannelInfo[]>([])
  const [loadError, setLoadError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [parseOpen, setParseOpen] = useState(false)
  const [editing, setEditing] = useState<AutomationInfo | null>(null)
  const [historyAutomation, setHistoryAutomation] = useState<AutomationInfo | null>(null)
  const [deleteAutomation, setDeleteAutomation] = useState<AutomationInfo | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [runningId, setRunningId] = useState<string | null>(null)
  const [runError, setRunError] = useState('')
  const [toggleError, setToggleError] = useState('')
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.get<AutomationInfo[]>('/automations')
      setList(data)
      setLoadError('')
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '任务列表加载失败')
    }
  }, [])

  useEffect(() => {
    void load()
    void api
      .get<DataSourceInfo[]>('/datasources')
      .then(setDatasources)
      .catch(() => setDatasources([]))
    void api
      .get<ChannelInfo[]>('/notifications/channels')
      .then(setChannels)
      .catch(() => setChannels([]))
  }, [load])

  const runNow = async (a: AutomationInfo) => {
    if (runningId) return
    setRunningId(a.id)
    setRunError('')
    try {
      await api.post(`/automations/${a.id}/run`)
      await load()
    } catch (e) {
      setRunError(`「${a.name}」运行失败：${e instanceof Error ? e.message : '未知错误'}`)
    } finally {
      setRunningId(null)
    }
  }

  const toggleEnabled = async (a: AutomationInfo, enabled: boolean) => {
    if (togglingId) return
    setTogglingId(a.id)
    setToggleError('')
    try {
      await api.post('/automations/update', { id: a.id, enabled })
      setList((prev) => (prev ? prev.map((x) => (x.id === a.id ? { ...x, enabled } : x)) : prev))
    } catch (e) {
      // 失败不改变本地状态（switch 回弹），并给出可读提示
      setToggleError(`「${a.name}」启停失败：${e instanceof Error ? e.message : '未知错误'}`)
    } finally {
      setTogglingId(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleteAutomation) return
    setDeleting(true)
    setDeleteError('')
    try {
      await api.post('/automations/delete', { id: deleteAutomation.id })
      setDeleteAutomation(null)
      void load()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-6 pb-1 pt-6">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground">定时任务</h2>
          <p className="text-xs text-muted-foreground">
            按 cron 计划执行只读查询，支持参数模板、图表快照与第三方通知
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setParseOpen(true)}>
            <Sparkles size={14} /> 智能解析
          </Button>
          <Button
            size="lg"
            onClick={() => {
              setEditing(null)
              setFormOpen(true)
            }}
          >
            <Plus /> 新建任务
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 px-6 pb-6 pt-4">
        {loadError && (
          <div className="flex items-center justify-between rounded-lg border border-error/30 bg-error-bg px-4 py-3">
            <p className="text-xs text-error">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </div>
        )}

        {runError && (
          <div className="flex items-center justify-between rounded-lg border border-error/30 bg-error-bg px-4 py-3">
            <p className="text-xs text-error">{runError}</p>
            <button
              onClick={() => setRunError('')}
              aria-label="关闭提示"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              关闭
            </button>
          </div>
        )}

        {toggleError && (
          <div className="flex items-center justify-between rounded-lg border border-error/30 bg-error-bg px-4 py-3">
            <p className="text-xs text-error">{toggleError}</p>
            <button
              onClick={() => setToggleError('')}
              aria-label="关闭提示"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              关闭
            </button>
          </div>
        )}

        {list === null && !loadError && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        )}

        {list !== null && list.length === 0 && !loadError && (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              <CalendarClock size={18} />
            </div>
            <p className="text-[13px] text-muted-foreground">
              暂无定时任务。可用「智能解析」用自然语言创建，或「新建任务」手动配置
            </p>
          </div>
        )}

        {list !== null && list.length > 0 && (
          <div className="overflow-hidden rounded-lg border bg-card">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">名称</th>
                  <th className="px-4 py-2.5 font-medium">数据源</th>
                  <th className="px-4 py-2.5 font-medium">计划</th>
                  <th className="px-4 py-2.5 font-medium">上次运行</th>
                  <th className="px-4 py-2.5 font-medium">下次运行</th>
                  <th className="px-4 py-2.5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {list.map((a) => {
                  const last = a.last_status ? LAST_STATUS[a.last_status] : null
                  const notify = a.notification
                  const hasNotify =
                    !!notify?.on_success?.enabled || !!notify?.on_failure?.enabled
                  return (
                    <tr key={a.id} className="border-t hover:bg-muted/50">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5 font-medium text-foreground">
                          {a.name}
                          {hasNotify && (
                            <span
                              title="已绑定运行结果通知"
                              className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground"
                            >
                              通知
                            </span>
                          )}
                        </div>
                        {a.description && (
                          <div className="max-w-[240px] truncate text-[11px] text-muted-foreground">
                            {a.description}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {a.datasource_name ?? '—'}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {a.readable ?? a.cron_expression}
                      </td>
                      <td className="px-4 py-2.5">
                        {a.last_run_at && last ? (
                          <span className="flex flex-col gap-0.5">
                            <span className="flex items-center gap-1.5">
                              <span aria-hidden className={`status-dot ${last.dot}`} />
                              <span className={last.text}>{last.label}</span>
                            </span>
                            <span className="text-[11px] text-muted-foreground">{formatTime(a.last_run_at)}</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">未运行</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {a.enabled ? formatTime(a.next_run_at) : <span className="text-muted-foreground/60">已停用</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-1.5">
                          <Switch
                            checked={a.enabled}
                            onCheckedChange={(v) => void toggleEnabled(a, v)}
                            disabled={togglingId === a.id}
                            aria-label={`${a.enabled ? '停用' : '启用'}任务 ${a.name}`}
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void runNow(a)}
                            disabled={runningId === a.id}
                          >
                            <Play size={12} />
                            {runningId === a.id ? '运行中…' : '运行'}
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => setHistoryAutomation(a)}>
                            <History size={12} /> 历史
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setEditing(a)
                              setFormOpen(true)
                            }}
                          >
                            编辑
                          </Button>
                          <Button variant="destructive" size="sm" onClick={() => setDeleteAutomation(a)}>
                            <Trash2 size={12} /> 删除
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <AutomationFormDialog
        open={formOpen}
        editing={editing}
        datasources={datasources}
        channels={channels}
        onOpenChange={(open) => {
          setFormOpen(open)
          if (!open) setEditing(null)
        }}
        onSaved={() => void load()}
      />

      <AutomationParseDialog
        open={parseOpen}
        datasources={datasources}
        channels={channels}
        onOpenChange={setParseOpen}
        onSaved={() => void load()}
        onUseForm={() => {
          setParseOpen(false)
          setEditing(null)
          setFormOpen(true)
        }}
      />

      <AutomationRunsDialog
        automation={historyAutomation}
        onClose={() => setHistoryAutomation(null)}
      />

      <Dialog
        open={deleteAutomation !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteAutomation(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除定时任务</DialogTitle>
            <DialogDescription>
              确定删除「{deleteAutomation?.name ?? ''}」吗？运行历史将一并删除，不可恢复。
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="text-xs text-error" role="alert">
              {deleteError}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteAutomation(null)} disabled={deleting}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting ? '删除中…' : '删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
