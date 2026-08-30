import { useEffect, useMemo, useState } from 'react'
import type { RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Bot, RefreshCw, ThumbsDown, ThumbsUp } from 'lucide-react'
import { api } from '@/lib/api'
import { useChat } from '@/hooks/useChat'
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
      } else {
        // 取消评分：rating=0 撤销后端已有反馈，刷新后不残留旧评分
        await api.post('/chat/feedback', { message_id: messageId, rating: 0 })
      }
    } catch {
      // 静默失败，不影响阅读
    } finally {
      setPending(false)
    }
  }

  return (
    // 无独立外边距：与「重新生成」按钮同处一个 items-center 行，由外层统一控制间距
    <div className="flex items-center gap-0.5 text-muted-foreground">
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

/** 单条消息渲染（用户气泡 / assistant 头像 + Block 流），供虚拟行复用 */
function MessageItem({
  message,
  index,
  streaming,
  onRetry,
  regenerate,
}: {
  message: Message
  index: number
  /** 当前这条消息是否正在流式生成（仅最后一条 assistant 真在生成，历史消息为 false） */
  streaming: boolean
  onRetry?: () => void
  regenerate: (assistantIndex: number) => void
}) {
  if (message.role === 'user') {
    const text = message.blocks.map((b) => String(b.content.text ?? '')).join('\n')
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] whitespace-pre-wrap rounded-[16px_16px_4px_16px] bg-user-bubble px-3.5 py-2.5 text-[13px] leading-6 text-user-bubble-fg">
          {text}
        </div>
      </div>
    )
  }

  const usage = message.metadata.usage as Record<string, unknown> | undefined
  const hasError = message.blocks.some((b) => b.status === 'failed' || b.type === 'error')
  // 生成中 = 该条消息处于流式生成：只要 streaming 为 true 就一直展示头像右侧的加载点。
  // 注意不能依赖 blocks.every(status==='running')——首个 text block 先 completed 时
  // （后续图表/表格仍在流式生成），every 会变 false 导致 loading 提前消失。
  const isTyping = streaming && !hasError
  // 流结束（非正在生成且无错误）才显示反馈按钮
  const showFeedback = !isTyping && message.blocks.length > 0 && !hasError

  return (
    <div className="flex">
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

        {message.blocks.length === 0 ? (
          <p className="text-sm text-muted-foreground">…</p>
        ) : (
          <div className="space-y-3">
            {message.blocks.map((b) => (
              <BlockViewer
                key={b.id}
                block={b}
                onRetry={onRetry}
                sessionId={message.session_id}
                messageId={message.id}
              />
            ))}
          </div>
        )}

        {showFeedback && (
          <div className="mt-2 flex items-center gap-1 text-muted-foreground">
            <FeedbackButtons messageId={message.id} />
            <button
              onClick={() => regenerate(index)}
              disabled={streaming}
              aria-label="重新生成"
              title="重新生成"
              className="flex items-center gap-1 rounded p-1 text-[11px] transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RefreshCw size={13} /> 重新生成
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 消息流（虚拟滚动，@tanstack/react-virtual）：
 * 用户气泡（深色右对齐） + AI 消息（头像+名称+Block 流）（docs/UI设计规范.md 3.4）。
 * 滚动容器由 ChatArea 持有（useStickToBottom），行高可变（measureElement 实测），
 * 仅渲染可视区 + overscan，长会话不整表重渲染。
 */
export function MessageList({
  messages,
  sending,
  onRetry,
  scrollRef,
  onSizeChange,
}: {
  messages: Message[]
  sending: boolean
  /** error block 重试回调（retryable 时显示重试按钮） */
  onRetry?: () => void
  /** 外层滚动容器（来自 useStickToBottom） */
  scrollRef: RefObject<HTMLDivElement | null>
  /** 虚拟总高度变化时回调（行高实测会让内容持续增长，贴底跟随需据此补滚） */
  onSizeChange?: () => void
}) {
  const { send } = useChat()

  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 96,
    overscan: 6,
  })

  // 行高实测（measureElement）会逐步更新总高度：仍在贴底且用户未操作时
  // 由 follow() 重新滚到底部，避免「内容长高但停在半空」的脱底残留。
  // follow 内部有 rAF 单飞 + stick/手势守卫，高频触发不会与用户抢滚。
  const totalSize = rowVirtualizer.getTotalSize()
  useEffect(() => {
    onSizeChange?.()
  }, [totalSize, onSizeChange])

  /** 当前正在流式生成的 assistant 消息 index：sending 时最后一条 assistant 才在生成。
   *  会话级 sending 会命中历史消息，需用「最后一条 assistant」精确收敛，避免历史消息误显示 loading。 */
  const streamingAssistantIndex = useMemo(() => {
    if (!sending) return -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return i
    }
    return -1
  }, [messages, sending])

  /** 重新生成：重发与该 assistant 配对的最近用户消息（保留原回复，PRD 5.1）。
   *  优先向前找；若 assistant 位于消息头部（created_at 相同导致顺序倒置等异常），向后兜底。 */
  const regenerate = (assistantIndex: number) => {
    const findUser = (from: number, dir: 1 | -1): string => {
      for (let i = from; i >= 0 && i < messages.length; i += dir) {
        if (messages[i].role === 'user') {
          return messages[i].blocks.map((b) => String(b.content.text ?? '')).join('\n')
        }
      }
      return ''
    }
    const text = findUser(assistantIndex - 1, -1) || findUser(assistantIndex + 1, 1)
    if (text) send(text)
  }

  return (
    <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
      {rowVirtualizer.getVirtualItems().map((vi) => {
        const m = messages[vi.index]
        return (
          <div
            key={m.id}
            data-index={vi.index}
            ref={rowVirtualizer.measureElement}
            className="pb-5" // 行距（对齐原 flex gap-5）
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${vi.start}px)`,
            }}
          >
            <MessageItem
              message={m}
              index={vi.index}
              streaming={vi.index === streamingAssistantIndex}
              onRetry={onRetry}
              regenerate={regenerate}
            />
          </div>
        )
      })}
    </div>
  )
}
