import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, Send } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import type { ChannelInfo, PushResult } from '@/types/notification'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const PROVIDER_LABEL: Record<string, string> = {
  email: '邮件',
  feishu: '飞书',
  wecom: '企微',
  dingtalk: '钉钉',
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 推送标题（取消息/图表标题，方案 §3.5） */
  subject: string
  /** 推送正文（简化结论文本，本期纯文本） */
  body: string
}

/** 对话结果主动推送（方案 §3.5/§4.3）：选渠道 → POST /api/notifications/send → 内联结果 + 重试 */
export function PushToChannelDialog({ open, onOpenChange, subject, body }: Props) {
  const [channels, setChannels] = useState<ChannelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [result, setResult] = useState<PushResult | null>(null)

  useEffect(() => {
    if (!open) return
    setResult(null)
    setSendingId(null)
    setLoadError('')
    setLoading(true)
    api
      .get<ChannelInfo[]>('/notifications/channels')
      .then((list) => setChannels(list.filter((c) => c.enabled)))
      .catch((e) => setLoadError(e instanceof ApiError ? e.message : '加载通知渠道失败'))
      .finally(() => setLoading(false))
  }, [open])

  const push = async (channelId: string) => {
    setSendingId(channelId)
    setResult(null)
    try {
      const res = await api.post<PushResult>('/notifications/send', {
        channel_id: channelId,
        subject,
        body,
      })
      setResult(res)
    } catch (e) {
      setResult({ ok: false, error: e instanceof ApiError ? e.message : '推送失败' })
    } finally {
      setSendingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>推送到…</DialogTitle>
          <DialogDescription>选择通知渠道发送当前结果摘要（本期仅纯文本）。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {loading ? (
            <div className="flex items-center gap-2 py-4 text-[13px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> 加载渠道…
            </div>
          ) : loadError ? (
            <div className="rounded border border-error/30 bg-error/5 px-3 py-2 text-[13px] text-error">
              {loadError}
            </div>
          ) : channels.length === 0 ? (
            <div className="py-4 text-center text-[13px] text-muted-foreground">
              暂无启用的通知渠道，请先在「通知渠道」页添加
            </div>
          ) : (
            channels.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => void push(c.id)}
                disabled={sendingId !== null}
                className="flex items-center justify-between rounded border border-input px-3 py-2 text-left text-[13px] hover:bg-accent disabled:cursor-wait disabled:opacity-60"
                aria-label={`推送到 ${c.name}`}
              >
                <span className="truncate">
                  <span className="mr-1.5 text-muted-foreground">
                    [{PROVIDER_LABEL[c.provider] ?? c.provider}]
                  </span>
                  {c.name}
                </span>
                {sendingId === c.id ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin" />
                ) : (
                  <Send className="size-3.5 shrink-0" />
                )}
              </button>
            ))
          )}
          {result
            ? result.ok
              ? (
                  // 异步推送结果：aria-live=polite 让读屏播报成功/失败状态
                  <div
                    role="status"
                    aria-live="polite"
                    className="flex items-center gap-1.5 rounded border border-success/30 bg-success/5 px-3 py-2 text-[13px] text-success"
                  >
                    <CheckCircle2 className="size-4 shrink-0" /> 推送成功
                  </div>
                )
              : (
                  <div
                    role="status"
                    aria-live="polite"
                    className="flex items-start gap-1.5 rounded border border-error/30 bg-error/5 px-3 py-2 text-[13px] text-error"
                  >
                    <AlertCircle className="mt-0.5 size-4 shrink-0" />
                    <span>{result.error ?? '推送失败'}</span>
                  </div>
                )
            : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
