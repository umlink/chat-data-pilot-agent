import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { ChannelInfo } from '@/types/notification'

interface TestResult {
  ok: boolean
  error?: string | null
}

/** 渠道连通性测试（POST /notifications/channels/test，不落发送记录）。 */
export function ChannelTestDialog({
  channel,
  onClose,
}: {
  channel: ChannelInfo | null
  onClose: () => void
}) {
  const [subject, setSubject] = useState('DataPilotAgent 测试通知')
  const [body, setBody] = useState('这是一条来自 DataPilotAgent 的测试消息')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)

  useEffect(() => {
    if (channel) {
      setSubject('DataPilotAgent 测试通知')
      setBody('这是一条来自 DataPilotAgent 的测试消息')
      setResult(null)
    }
  }, [channel])

  const test = async () => {
    if (sending || !channel) return
    setSending(true)
    setResult(null)
    try {
      const res = await api.post<TestResult>('/notifications/channels/test', {
        channel_id: channel.id,
        subject,
        body,
      })
      setResult(res)
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : '测试失败' })
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={channel !== null} onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>测试渠道 — {channel?.name ?? ''}</DialogTitle>
          <DialogDescription>发送一条测试消息验证连通性（不写入发送记录）</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="test-subject">标题</Label>
            <Input
              id="test-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={200}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="test-body">正文</Label>
            <Textarea
              id="test-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="min-h-[80px] text-[13px]"
            />
          </div>
          {result && (
            result.ok ? (
              <div className="flex items-center gap-1.5 rounded border border-success/30 bg-success/5 px-3 py-2 text-[13px] text-success">
                <CheckCircle2 className="size-4 shrink-0" /> 发送成功，渠道配置可用
              </div>
            ) : (
              <div className="flex items-start gap-1.5 rounded border border-error/30 bg-error/5 px-3 py-2 text-[13px] text-error">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>{result.error ?? '发送失败'}</span>
              </div>
            )
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
          <Button onClick={() => void test()} disabled={sending}>
            {sending ? <Loader2 className="size-4 animate-spin" /> : null}
            {sending ? '发送中…' : '发送测试'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
