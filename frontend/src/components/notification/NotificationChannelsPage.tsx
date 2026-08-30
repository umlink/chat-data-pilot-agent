import { useCallback, useEffect, useState } from 'react'
import { Bell, Plus, Send, Trash2 } from 'lucide-react'
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
import type { ChannelInfo, NotificationLogInfo } from '@/types/notification'
import { ChannelFormDialog } from './ChannelFormDialog'
import { ChannelTestDialog } from './ChannelTestDialog'

const PROVIDER_LABEL: Record<string, string> = {
  email: '邮件',
  feishu: '飞书',
  wecom: '企业微信',
  dingtalk: '钉钉',
}

function formatTime(value?: string | null): string {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 通知渠道管理页：渠道 CRUD + 测试 + 发送记录（发送后写入，供审计/重试）。 */
export function NotificationChannelsPage() {
  const [list, setList] = useState<ChannelInfo[] | null>(null)
  const [logs, setLogs] = useState<NotificationLogInfo[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ChannelInfo | null>(null)
  const [testChannel, setTestChannel] = useState<ChannelInfo | null>(null)
  const [deleteChannel, setDeleteChannel] = useState<ChannelInfo | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.get<ChannelInfo[]>('/notifications/channels')
      setList(data)
      setLoadError('')
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '渠道列表加载失败')
    }
  }, [])

  const loadLogs = useCallback(async () => {
    try {
      const data = await api.get<NotificationLogInfo[]>('/notifications/logs?limit=20')
      setLogs(data)
    } catch {
      setLogs([])
    }
  }, [])

  useEffect(() => {
    void load()
    void loadLogs()
  }, [load, loadLogs])

  const toggleEnabled = async (c: ChannelInfo, enabled: boolean) => {
    if (togglingId) return
    setTogglingId(c.id)
    try {
      await api.post('/notifications/channels/update', { id: c.id, enabled })
      setList((prev) => (prev ? prev.map((x) => (x.id === c.id ? { ...x, enabled } : x)) : prev))
    } catch {
      // 失败不改变本地状态
    } finally {
      setTogglingId(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleteChannel) return
    setDeleting(true)
    setDeleteError('')
    try {
      await api.post('/notifications/channels/delete', { id: deleteChannel.id })
      setDeleteChannel(null)
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
          <h2 className="text-[15px] font-semibold text-foreground">通知渠道</h2>
          <p className="text-xs text-muted-foreground">
            配置飞书 / 企业微信 / 钉钉 / 邮件，供定时任务与对话结果推送通知
          </p>
        </div>
        <Button
          size="lg"
          onClick={() => {
            setEditing(null)
            setFormOpen(true)
          }}
        >
          <Plus /> 新增渠道
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-6 px-6 pb-6 pt-4">
        {loadError && (
          <div className="flex items-center justify-between rounded-lg border border-error/30 bg-error-bg px-4 py-3">
            <p className="text-xs text-error">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
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
              <Bell size={18} />
            </div>
            <p className="text-[13px] text-muted-foreground">
              暂无通知渠道，点击右上角「新增渠道」配置第一个
            </p>
          </div>
        )}

        {list !== null && list.length > 0 && (
          <div className="overflow-hidden rounded-lg border bg-card">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">名称</th>
                  <th className="px-4 py-2.5 font-medium">类型</th>
                  <th className="px-4 py-2.5 font-medium">状态</th>
                  <th className="px-4 py-2.5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id} className="border-t hover:bg-muted/50">
                    <td className="px-4 py-2.5 font-medium text-foreground">{c.name}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {PROVIDER_LABEL[c.provider] ?? c.provider}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-1.5">
                        <span
                          aria-hidden
                          className={`status-dot ${c.enabled ? 'succeeded' : 'idle'}`}
                        />
                        <span className={c.enabled ? 'text-success' : 'text-muted-foreground'}>
                          {c.enabled ? '已启用' : '已停用'}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        <Switch
                          checked={c.enabled}
                          onCheckedChange={(v) => void toggleEnabled(c, v)}
                          disabled={togglingId === c.id}
                          aria-label={`${c.enabled ? '停用' : '启用'}渠道 ${c.name}`}
                        />
                        <Button variant="outline" size="sm" onClick={() => setTestChannel(c)}>
                          <Send size={12} /> 测试
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditing(c)
                            setFormOpen(true)
                          }}
                        >
                          编辑
                        </Button>
                        <Button variant="destructive" size="sm" onClick={() => setDeleteChannel(c)}>
                          <Trash2 size={12} /> 删除
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <section>
          <h3 className="mb-2 text-[13px] font-medium text-foreground">发送记录</h3>
          {logs === null ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : logs.length === 0 ? (
            <div className="rounded-lg border border-dashed py-8 text-center text-[13px] text-muted-foreground">
              暂无发送记录
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border bg-card">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2 font-medium">时间</th>
                    <th className="px-4 py-2 font-medium">标题</th>
                    <th className="px-4 py-2 font-medium">状态</th>
                    <th className="px-4 py-2 font-medium">错误</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((l) => (
                    <tr key={l.id} className="border-t hover:bg-muted/50">
                      <td className="px-4 py-2 text-muted-foreground">{formatTime(l.created_at)}</td>
                      <td className="max-w-[240px] truncate px-4 py-2 text-foreground" title={l.subject ?? ''}>
                        {l.subject ?? '-'}
                      </td>
                      <td className="px-4 py-2">
                        <span className="flex items-center gap-1.5">
                          <span
                            aria-hidden
                            className={`status-dot ${l.status === 'success' ? 'succeeded' : 'failed'}`}
                          />
                          <span className={l.status === 'success' ? 'text-success' : 'text-error'}>
                            {l.status === 'success' ? '成功' : '失败'}
                          </span>
                        </span>
                      </td>
                      <td className="max-w-[220px] truncate px-4 py-2 text-error" title={l.error ?? ''}>
                        {l.error ?? '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <ChannelFormDialog
        open={formOpen}
        editing={editing}
        onOpenChange={(open) => {
          setFormOpen(open)
          if (!open) setEditing(null)
        }}
        onSaved={() => void load()}
      />

      <ChannelTestDialog channel={testChannel} onClose={() => setTestChannel(null)} />

      <Dialog
        open={deleteChannel !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteChannel(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除通知渠道</DialogTitle>
            <DialogDescription>
              确定删除「{deleteChannel?.name ?? ''}」吗？引用它的定时任务通知绑定将自动解除。
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="text-xs text-error" role="alert">
              {deleteError}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteChannel(null)} disabled={deleting}>
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
