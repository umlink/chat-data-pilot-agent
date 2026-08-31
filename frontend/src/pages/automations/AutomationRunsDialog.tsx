import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { ChartBlock } from '@/components/chat/ChartBlock'
import { TableBlock } from '@/components/chat/TableBlock'
import type { AutomationInfo, AutomationRunInfo } from '@/types/automation'
import { cn } from '@/lib/utils'

function formatTime(value?: string | null): string {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const STATUS_LABEL: Record<string, { label: string; dot: string; text: string }> = {
  success: { label: '成功', dot: 'succeeded', text: 'text-success' },
  failed: { label: '失败', dot: 'failed', text: 'text-error' },
  running: { label: '运行中', dot: 'running', text: 'text-info' },
}

/** 定时任务运行历史：运行列表（状态/耗时/错误）+ 选中运行的结果快照（表格 + 图表）。 */
export function AutomationRunsDialog({
  automation,
  onClose,
}: {
  automation: AutomationInfo | null
  onClose: () => void
}) {
  const [runs, setRuns] = useState<AutomationRunInfo[] | null>(null)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    if (!automation) return
    let alive = true
    setRuns(null)
    setSelectedId(null)
    setError('')
    setHasMore(false)
    void api
      .get<AutomationRunInfo[]>(`/automations/${automation.id}/runs?limit=20&offset=0`)
      .then((list) => {
        if (!alive) return
        // 每页展示 limit 条；limit+1 探测余量仅用于判断是否还有更多
        const shown = list.slice(0, 20)
        setRuns(shown)
        // 返回超过 limit 视为还有下一页
        setHasMore(list.length > 20)
        // 默认选中最近一次成功运行（有结果快照可看），否则第一条
        const first = shown.find((r) => r.status === 'success' && r.result) ?? shown[0]
        setSelectedId(first?.id ?? null)
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : '运行历史加载失败')
      })
    return () => {
      alive = false
    }
  }, [automation])

  const loadMore = async () => {
    if (!automation || runs === null || loadingMore) return
    setLoadingMore(true)
    try {
      const next = await api.get<AutomationRunInfo[]>(
        `/automations/${automation.id}/runs?limit=20&offset=${runs.length}`,
      )
      // 追加下一页（同样截取 limit 条，余量仅作 hasMore 信号）
      setRuns((prev) => [...(prev ?? []), ...next.slice(0, 20)])
      setHasMore(next.length > 20)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载更多失败')
    } finally {
      setLoadingMore(false)
    }
  }

  const selected = runs?.find((r) => r.id === selectedId) ?? null

  return (
    <Dialog open={automation !== null} onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>运行历史 — {automation?.name ?? ''}</DialogTitle>
          <DialogDescription>自动与手动执行记录，点击查看结果快照</DialogDescription>
        </DialogHeader>

        {error && <p className="px-1 text-xs text-error">{error}</p>}

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-1">
          {runs === null && !error && (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          )}

          {runs !== null && runs.length === 0 && (
            <div className="py-10 text-center text-[13px] text-muted-foreground">
              暂无运行记录，可回到任务列表点击「运行」立即执行一次
            </div>
          )}

          {runs !== null && runs.length > 0 && (
            <>
              <div className="overflow-hidden rounded-lg border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 font-medium">时间</th>
                      <th className="px-3 py-2 font-medium">状态</th>
                      <th className="px-3 py-2 font-medium">耗时</th>
                      <th className="px-3 py-2 font-medium">错误</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => {
                      const st = STATUS_LABEL[r.status] ?? STATUS_LABEL.running
                      return (
                        <tr
                          key={r.id}
                          tabIndex={0}
                          onClick={() => setSelectedId(r.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              setSelectedId(r.id)
                            }
                          }}
                          className={cn(
                            'cursor-pointer border-t hover:bg-muted/50',
                            selectedId === r.id && 'bg-accent',
                          )}
                        >
                          <td className="px-3 py-2 text-muted-foreground">{formatTime(r.started_at)}</td>
                          <td className="px-3 py-2">
                            <span className="flex items-center gap-1.5">
                              <span aria-hidden className={`status-dot ${st.dot}`} />
                              <span className={st.text}>{st.label}</span>
                            </span>
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : '-'}
                          </td>
                          <td className="max-w-[280px] truncate px-3 py-2 text-error" title={r.error ?? ''}>
                            {r.error ?? '-'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {hasMore && (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                  >
                    {loadingMore ? '加载中…' : '加载更多'}
                  </Button>
                </div>
              )}

              {selected && (
                <div className="space-y-3 rounded-lg border bg-card p-4">
                  <div className="text-[13px] font-semibold text-foreground">
                    结果快照（{formatTime(selected.started_at)}）
                  </div>
                  {selected.result?.table ? (
                    <TableBlock content={selected.result.table} />
                  ) : (
                    <div className="py-6 text-center text-[13px] text-muted-foreground">
                      该次运行没有结果快照（失败或无数据）
                    </div>
                  )}
                  {selected.result?.chart && (
                    <div className="rounded-lg border bg-card p-4">
                      <ChartBlock content={selected.result.chart} />
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end pt-1">
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
