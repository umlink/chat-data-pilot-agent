import { useState } from 'react'
import { Bot, ThumbsDown, ThumbsUp } from 'lucide-react'
import { api } from '@/lib/api'
import type { Message } from '@/types/message'
import { BlockViewer } from './BlockViewer'

/** 单条 assistant 消息的反馈按钮 */
function FeedbackButtons({ messageId }: { messageId: string }) {
  const [rating, setRating] = useState<1 | -1 | null>(null)
  const [pending, setPending] = useState(false)

  const rate = async (value: 1 | -1) => {
    if (pending) return
    setPending(true)
    // 再次点击同个按钮 = 取消
    const next = rating === value ? null : value
    setRating(next)
    try {
      if (next !== null) {
        await api.post('/chat/feedback', { message_id: messageId, rating: next })
      }
    } catch {
      // 静默失败，不影响阅读
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mt-2 flex items-center gap-1 text-muted-foreground">
      <button
        onClick={() => void rate(1)}
        disabled={pending}
        aria-label="有帮助"
        className={`rounded p-1 transition-colors hover:bg-accent hover:text-foreground ${
          rating === 1 ? 'text-success' : ''
        }`}
      >
        <ThumbsUp size={13} />
      </button>
      <button
        onClick={() => void rate(-1)}
        disabled={pending}
        aria-label="没帮助"
        className={`rounded p-1 transition-colors hover:bg-accent hover:text-foreground ${
          rating === -1 ? 'text-error' : ''
        }`}
      >
        <ThumbsDown size={13} />
      </button>
    </div>
  )
}

/** 消息流：用户气泡（深色右对齐） + AI 消息（头像+名称+Block 流） （docs/UI设计规范.md 3.4） */
export function MessageList({
  messages,
  sending,
  onRetry,
}: {
  messages: Message[]
  sending: boolean
  /** error block 重试回调（retryable 时显示重试按钮） */
  onRetry?: () => void
}) {
  return (
    <div className="flex flex-col gap-5">
      {messages.map((m) => {
        if (m.role === 'user') {
          const text = m.blocks.map((b) => String(b.content.text ?? '')).join('\n')
          return (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[75%] whitespace-pre-wrap rounded-[16px_16px_4px_16px] bg-user-bubble px-3.5 py-2.5 text-[13px] leading-6 text-user-bubble-fg">
                {text}
              </div>
            </div>
          )
        }

        const usage = m.metadata.usage as Record<string, unknown> | undefined
        const isTyping =
          sending && m.blocks.length > 0 && m.blocks.every((b) => b.status === 'running')
        const hasError = m.blocks.some((b) => b.status === 'failed' || b.type === 'error')
        // 流结束（非 running 且非空）才显示反馈按钮
        const showFeedback =
          !isTyping && m.blocks.length > 0 && !hasError

        return (
          <div key={m.id} className="flex">
            <div className="w-full">
              <div className="mb-2.5 flex items-center gap-2.5">
                <div className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Bot size={14} />
                </div>
                <span className="text-xs font-semibold text-foreground">DataPilot</span>
                {isTyping && (
                  <span className="flex items-center gap-1">
                    <span className="size-1.5 animate-pulse-dot rounded-full bg-muted-foreground" />
                    <span className="size-1.5 animate-pulse-dot rounded-full bg-muted-foreground [animation-delay:150ms]" />
                    <span className="size-1.5 animate-pulse-dot rounded-full bg-muted-foreground [animation-delay:300ms]" />
                  </span>
                )}
                {usage !== undefined && (
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    消耗约 {Number(usage.total_tokens ?? 0)} tokens
                  </span>
                )}
              </div>

              {m.blocks.length === 0 ? (
                <p className="text-sm text-muted-foreground">…</p>
              ) : (
                <div className="space-y-3">
                  {m.blocks.map((b) => (
                    <BlockViewer key={b.id} block={b} onRetry={onRetry} />
                  ))}
                </div>
              )}

              {showFeedback && <FeedbackButtons messageId={m.id} />}
            </div>
          </div>
        )
      })}
    </div>
  )
}