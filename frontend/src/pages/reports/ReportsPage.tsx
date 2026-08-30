import { useCallback, useEffect, useState } from 'react'
import { CalendarClock, History, Play, Plus, Trash2 } from 'lucide-react'
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
import type { ReportInfo } from '@/types/analytics'
import { ReportFormDialog } from './ReportFormDialog'
import { ReportRunsDialog } from './ReportRunsDialog'

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

function formatTime(value?: string | null): string {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 计划描述：每天 09:00 / 每周三 09:00 / 每月 1 日 09:00 */
function scheduleLabel(r: ReportInfo): string {
  if (r.schedule_type === 'weekly') return `每${WEEKDAYS[r.day_of_week ?? 0]} ${r.schedule_time}`
  if (r.schedule_type === 'monthly') return `每月 ${r.day_of_month ?? 1} 日 ${r.schedule_time}`
  return `每天 ${r.schedule_time}`
}

const LAST_STATUS = {
  success: { label: '成功', dot: 'succeeded', text: 'text-success' },
  failed: { label: '失败', dot: 'failed', text: 'text-error' },
  running: { label: '运行中', dot: 'running', text: 'text-info' },
} as const

/** 定时报告管理页：列表（计划/状态/下次运行）+ 新建/编辑/启停/立即运行/历史/删除。 */
export function ReportsPage() {
  const [list, setList] = useState<ReportInfo[] | null>(null)
  const [datasources, setDatasources] = useState<DataSourceInfo[]>([])
  const [loadError, setLoadError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ReportInfo | null>(null)
  const [historyReport, setHistoryReport] = useState<ReportInfo | null>(null)
  const [deleteReport, setDeleteReport] = useState<ReportInfo | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [runningId, setRunningId] = useState<string | null>(null)
  const [runError, setRunError] = useState('')
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.get<ReportInfo[]>('/reports')
      setList(data)
      setLoadError('')
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '报告列表加载失败')
    }
  }, [])

  useEffect(() => {
    void load()
    void api
      .get<DataSourceInfo[]>('/datasources')
      .then(setDatasources)
      .catch(() => setDatasources([])) // 数据源列表失败不阻塞报告页（可继续用默认数据源）
  }, [load])

  /** 立即运行（同步执行，后端 60s 超时收敛） */
  const runNow = async (r: ReportInfo) => {
    if (runningId) return
    setRunningId(r.id)
    setRunError('')
    try {
      await api.post(`/reports/${r.id}/run`)
      await load()
    } catch (e) {
      setRunError(`「${r.name}」运行失败：${e instanceof Error ? e.message : '未知错误'}`)
    } finally {
      setRunningId(null)
    }
  }

  /** 启停切换（重算 next_run_at） */
  const toggleEnabled = async (r: ReportInfo, enabled: boolean) => {
    if (togglingId) return
    setTogglingId(r.id)
    try {
      await api.post('/reports/update', { id: r.id, enabled })
      setList((prev) => (prev ? prev.map((x) => (x.id === r.id ? { ...x, enabled } : x)) : prev))
    } catch {
      // 失败不改变本地状态，下次加载自然回正
    } finally {
      setTogglingId(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleteReport) return
    setDeleting(true)
    setDeleteError('')
    try {
      await api.post('/reports/delete', { id: deleteReport.id })
      setDeleteReport(null)
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
          <h2 className="text-[15px] font-semibold text-foreground">定时报告</h2>
          <p className="text-xs text-muted-foreground">
            按计划自动执行只读 SELECT 查询，保留最近 50 次运行结果与图表快照
          </p>
        </div>
        <Button
          size="lg"
          onClick={() => {
            setEditing(null)
            setFormOpen(true)
          }}
        >
          <Plus /> 新建报告
        </Button>
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
              暂无定时报告，点击右上角「新建报告」创建第一个自动查询
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
                {list.map((r) => {
                  const last = r.last_status ? LAST_STATUS[r.last_status] : null
                  return (
                    <tr key={r.id} className="border-t hover:bg-muted/50">
                      <td className="px-4 py-2.5 font-medium text-foreground">{r.name}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {r.datasource_name ?? '默认数据源'}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{scheduleLabel(r)}</td>
                      <td className="px-4 py-2.5">
                        {r.last_run_at && last ? (
                          <span className="flex flex-col gap-0.5" title={r.last_status === 'failed' ? '最近一次运行失败' : undefined}>
                            <span className="flex items-center gap-1.5">
                              <span aria-hidden className={`status-dot ${last.dot}`} />
                              <span className={last.text}>{last.label}</span>
                            </span>
                            <span className="text-[11px] text-muted-foreground">{formatTime(r.last_run_at)}</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">未运行</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {r.enabled ? formatTime(r.next_run_at) : <span className="text-muted-foreground/60">已停用</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-1.5">
                          <Switch
                            checked={r.enabled}
                            onCheckedChange={(v) => void toggleEnabled(r, v)}
                            disabled={togglingId === r.id}
                            aria-label={`${r.enabled ? '停用' : '启用'}报告 ${r.name}`}
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void runNow(r)}
                            disabled={runningId === r.id}
                          >
                            <Play size={12} />
                            {runningId === r.id ? '运行中…' : '运行'}
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => setHistoryReport(r)}>
                            <History size={12} /> 历史
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setEditing(r)
                              setFormOpen(true)
                            }}
                          >
                            编辑
                          </Button>
                          <Button variant="destructive" size="sm" onClick={() => setDeleteReport(r)}>
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

      <ReportFormDialog
        open={formOpen}
        editing={editing}
        datasources={datasources}
        onOpenChange={(open) => {
          setFormOpen(open)
          if (!open) setEditing(null)
        }}
        onSaved={() => void load()}
      />

      <ReportRunsDialog report={historyReport} onClose={() => setHistoryReport(null)} />

      <Dialog
        open={deleteReport !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteReport(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除定时报告</DialogTitle>
            <DialogDescription>
              确定删除「{deleteReport?.name ?? ''}」吗？运行历史将一并删除，不可恢复。
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="text-xs text-error" role="alert">
              {deleteError}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteReport(null)} disabled={deleting}>
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
