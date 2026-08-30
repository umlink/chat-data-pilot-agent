import { lazy, Suspense, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { api } from '@/lib/api'
import { useChat } from '@/hooks/useChat'
import { useChatStore } from '@/store/chatStore'
import type {
  AttachmentContent,
  ChartContent,
  CodeContent,
  ConfirmationContent,
  ErrorContent,
  InsightItem,
  ProgressContent,
  SourcesContent,
  SuggestionItem,
  TableContent,
} from '@/types/message'
import type { Block } from '@/types/message'
import { AttachmentBlock } from './AttachmentBlock'
import { CodeBlock } from './CodeBlock'
import { ConfirmationBlock } from './ConfirmationBlock'
import { MarkdownText } from './MarkdownText'
import { SourcesBlock } from './SourcesBlock'
import { TableBlock } from './TableBlock'

// ChartBlock（recharts ~120KB gzip）仅在出现 chart block 时懒加载
const ChartBlock = lazy(() =>
  import('./ChartBlock').then((m) => ({ default: m.ChartBlock })),
)

function ChartSkeleton() {
  return (
    <div className="flex h-56 w-full items-end justify-center gap-2 rounded-md bg-muted/30 px-6 pb-4">
      {[0.4, 0.65, 0.5, 0.8, 0.95, 0.75, 0.6, 0.5].map((h, i) => (
        <div
          key={i}
          className="w-8 animate-pulse rounded-t bg-muted"
          style={{ height: `${h * 100}%` }}
        />
      ))}
    </div>
  )
}

/**
 * 各类型 Block 的复制内容（PRD 5.1 所有 Block 一键复制）。
 * code 自带复制按钮，此处跳过避免重复；suggestions/progress/attachment 无纯文本内容，跳过。
 */
function copyTextOf(block: Block): string | null {
  const c = block.content
  switch (block.type) {
    case 'text':
      return String(c.text ?? '') || null
    case 'table': {
      const { columns = [], rows = [] } = c as unknown as TableContent
      if (columns.length === 0) return null
      const header = columns.map((col) => col.label ?? col.key).join('\t')
      const lines = (rows as Record<string, unknown>[]).map((r) =>
        columns.map((col) => String(r[col.key] ?? '')).join('\t'),
      )
      return [header, ...lines].join('\n')
    }
    case 'chart': {
      const content = c as unknown as ChartContent
      const parts = [content.title, content.query].filter(Boolean)
      return parts.length > 0 ? parts.join('\n') : null
    }
    case 'insights': {
      const items = (c.items as InsightItem[]) ?? []
      const lines = items.map((it) => (it.detail ? `${it.title}：${it.detail}` : it.title))
      return lines.length > 0 ? lines.join('\n') : null
    }
    case 'confirmation': {
      const content = c as unknown as ConfirmationContent
      return content.sql ?? content.description ?? null
    }
    case 'error': {
      const content = c as unknown as ErrorContent
      return content.message || null
    }
    default:
      return null
  }
}

/** 悬浮复制按钮：hover 显示，点击复制 */
function CopyBlockButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* 剪贴板不可用时静默 */
    }
  }
  return (
    <button
      onClick={() => void copy()}
      aria-label="复制内容"
      title="复制"
      className="absolute -right-2 -top-2 z-10 inline-flex size-6 items-center justify-center rounded-md border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground group-hover/block:opacity-100 focus-visible:opacity-100"
    >
      {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
    </button>
  )
}

/**
 * Block 渲染（docs/UI设计规范.md 4 与 docs/Block与协议规范.md 第 2 章）。
 * confirmation / attachment / table 交互组件拆在 chat/ 子文件中。
 * sessionId/messageId 供 attachment 等需回写消息内 block 的交互组件使用。
 */
export function BlockViewer({
  block,
  onRetry,
  sessionId,
  messageId,
}: {
  block: Block
  onRetry?: () => void
  sessionId?: string
  messageId?: string
}) {
  const c = block.content
  const { send } = useChat()
  const [cancelling, setCancelling] = useState(false)

  /** 取消进行中的任务（PRD 补充「任务取消」）：POST /api/tasks/{id}/cancel，按服务端快照更新状态 */
  const cancelTask = async (taskId: string) => {
    if (!sessionId || !messageId || cancelling) return
    setCancelling(true)
    try {
      const snap = await api.post<{ status?: string }>(`/tasks/${taskId}/cancel`)
      const st = useChatStore.getState()
      const status = snap?.status
      if (status === 'cancelled') {
        st.patchBlock(sessionId, messageId, block.id, { cancelled: true, cancellable: false })
        st.setBlockStatus(sessionId, messageId, block.id, 'cancelled')
      } else if (status === 'failed') {
        st.patchBlock(sessionId, messageId, block.id, { failed: true, cancellable: false })
        st.setBlockStatus(sessionId, messageId, block.id, 'failed')
      } else if (status === 'success') {
        // 任务已成功：仅解除可取消标记，不误标已取消
        st.patchBlock(sessionId, messageId, block.id, { cancellable: false })
      }
      // 任务仍 pending/running：取消已受理，终态由 task_status 事件驱动
    } catch {
      /* 取消失败：任务可能已完成，保持现状 */
    } finally {
      setCancelling(false)
    }
  }

  const renderBlock = (): ReactNode => {
    switch (block.type) {
      case 'text':
        return <MarkdownText text={String(c.text ?? '')} />

      case 'code':
        return <CodeBlock block={block} content={c as unknown as CodeContent} />

      case 'table':
        return <TableBlock content={c as unknown as TableContent} />

      case 'chart': {
        const content = c as unknown as ChartContent
        return (
          <div className="rounded-lg border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
            <div className="p-4">
              <Suspense fallback={<ChartSkeleton />}>
                <ChartBlock content={content} savable sessionId={sessionId} />
              </Suspense>
            </div>
          </div>
        )
      }

      case 'confirmation':
        return <ConfirmationBlock block={block} content={c as unknown as ConfirmationContent} />

      case 'insights': {
        const items = (c.items as InsightItem[]) ?? []
        return (
          <ul className="space-y-1 text-[13px] leading-6 text-foreground">
            {items.map((it) => (
              <li key={it.title.slice(0, 20)}>
                <b>{it.title}</b>
                {it.detail ? ` ${it.detail}` : ''}
              </li>
            ))}
          </ul>
        )
      }

      case 'suggestions': {
        const items = (c.items as SuggestionItem[]) ?? []
        return (
          <div className="flex flex-wrap gap-2">
            {items.map((it) => (
              <button
                key={it.text}
                onClick={() => send(it.message || it.text)}
                className="rounded-md border bg-background px-3 py-1 text-xs text-foreground hover:bg-accent"
              >
                {it.text}
              </button>
            ))}
          </div>
        )
      }

      case 'sources':
        return <SourcesBlock content={c as unknown as SourcesContent} />

      case 'progress': {
        const content = c as unknown as ProgressContent
        const done = content.cancelled || content.failed
        const showCancel =
          !done && block.status === 'running' && content.cancellable && !!content.task_id
        return (
          <div>
            <div className="mb-1 flex justify-between text-xs text-muted-foreground">
              <span>
                {content.cancelled
                  ? '已取消'
                  : content.failed
                    ? content.error
                      ? `任务失败：${content.error}`
                      : '任务失败'
                    : (content.current_step ?? '处理中…')}
              </span>
              <span>{done ? '' : `${content.percent}%`}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all ${
                  content.failed ? 'bg-error' : content.cancelled ? 'bg-muted' : 'bg-primary'
                }`}
                style={{ width: `${content.percent}%` }}
              />
            </div>
            {(showCancel || done) && (
              <div className="mt-2 flex items-center gap-2">
                {showCancel && (
                  <button
                    onClick={() => void cancelTask(content.task_id)}
                    disabled={cancelling}
                    aria-label="取消任务"
                    className="rounded-md border px-2.5 py-1 text-xs text-foreground hover:bg-accent disabled:cursor-wait disabled:opacity-40"
                  >
                    {cancelling ? '取消中…' : '取消'}
                  </button>
                )}
                {done && onRetry && (
                  <button
                    onClick={onRetry}
                    aria-label="重试任务"
                    className="rounded-md border px-2.5 py-1 text-xs text-foreground hover:bg-accent"
                  >
                    重试
                  </button>
                )}
              </div>
            )}
          </div>
        )
      }

      case 'error': {
        const content = c as unknown as ErrorContent
        return (
          <div className="rounded-lg border border-error bg-error-bg p-3 text-[13px] leading-6 text-error">
            <div>{content.message}</div>
            {content.retryable && onRetry && (
              <button
                onClick={onRetry}
                className="mt-2 rounded border border-error/40 px-2.5 py-1 text-xs hover:bg-error/10"
              >
                重试
              </button>
            )}
          </div>
        )
      }

      case 'attachment':
        return (
          <AttachmentBlock
            content={c as unknown as AttachmentContent}
            context={sessionId && messageId ? { sessionId, messageId, blockId: block.id } : undefined}
          />
        )

      default:
        return null
    }
  }

  const copyText = copyTextOf(block)
  const inner = renderBlock()
  if (inner === null || copyText === null) return inner
  return (
    <div className="group/block relative">
      {inner}
      <CopyBlockButton text={copyText} />
    </div>
  )
}
