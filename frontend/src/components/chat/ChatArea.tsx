import { useEffect, useMemo } from 'react'
import { MessageSquare } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '@/lib/api'
import { useChatStore } from '@/store/chatStore'
import { useDataSourceStore, type DataSourceInfo } from '@/store/dataSourceStore'
import { cancelAllStreams, useChat } from '@/hooks/useChat'
import { useStickToBottom } from '@/hooks/useStickToBottom'
import { ensureSession } from '@/hooks/useAttachments'
import { CONTEXT_LIMIT, CONTEXT_WARN_RATIO, estimateContextTokens } from '@/lib/tokenEstimate'
import type { Message } from '@/types/message'
import { AttachmentDrafts } from './AttachmentDrafts'
import { MessageList } from './MessageList'
import { Composer } from './Composer'

const EXAMPLES = [
  { text: '按月份统计销售额趋势', prompt: '请根据当前数据源，按月份统计销售额趋势。' },
  { text: '哪些客户贡献了大部分收入', prompt: '请分析哪些客户贡献了大部分收入，并给出占比。' },
  { text: '主要指标对比近三个月', prompt: '请对比近三个月的核心业务指标变化。' },
]

/**
 * 中栏对话区：消息流 + 空状态 + 输入区（docs/UI设计规范.md 2 / 3.12）。
 * 会话与 URL 绑定：/session/:id 是唯一权威来源。
 * 切换会话**不中断**后台 SSE（流按 sessionId 独立，切回时已完成结果可见）；
 * 仅登出/组件卸载时取消全部流。
 */
export function ChatArea() {
  const { id } = useParams()
  const navigate = useNavigate()
  const sessionId = useChatStore((s) => s.sessionId)
  const setSessionId = useChatStore((s) => s.setSessionId)
  const setSessionMessages = useChatStore((s) => s.setSessionMessages)
  const { send } = useChat()
  const setDsList = useDataSourceStore((s) => s.setList)

  // 当前会话的消息 + sending（多会话隔离）。
  // 注意：selector 必须返回稳定引用，不能用 `?? []`（每次渲染新数组 → 无限循环）
  const rawMessages = useChatStore((s) => (sessionId ? s.messagesBySession[sessionId] : undefined))
  const sending = useChatStore((s) => (sessionId ? !!s.sending[sessionId] : false))
  const messages = useMemo(() => rawMessages ?? [], [rawMessages])
  // 上下文接近上限提示（PRD 3.1.1）
  const tokenEstimate = useMemo(() => estimateContextTokens(messages), [messages])
  const nearContextLimit = tokenEstimate >= CONTEXT_LIMIT * CONTEXT_WARN_RATIO

  const { ref: scrollRef, follow, forceScroll } = useStickToBottom<HTMLDivElement>()
  useEffect(() => follow(), [messages, sending, follow])

  // 路由 → store 同步 + 加载历史（不 abort 其它会话的流）
  useEffect(() => {
    if (!id) {
      setSessionId(null)
      return
    }
    if (id === sessionId) return
    setSessionId(id)
    // D1：切换会话不中断后台流。若目标会话正在流式（assistant 消息尚未落库），
    // 跳过 DB 快照回填、信任本地流式状态，避免覆盖导致进行中的回答丢失。
    if (useChatStore.getState().sending[id]) return
    let alive = true
    void api
      .get<Message[]>(`/sessions/${id}/messages`)
      .then((msgs) => {
        if (alive) setSessionMessages(id, msgs)
      })
      .catch(() => {
        if (alive) setSessionMessages(id, [])
      })
    return () => {
      alive = false
    }
  }, [id, sessionId, setSessionId, setSessionMessages])

  // 组件卸载（登出等）时取消所有流
  useEffect(() => () => cancelAllStreams(), [])

  // 聊天页数据源选择器依赖列表：store 为空时拉取一次（失败静默，选择器自动隐藏）
  useEffect(() => {
    let alive = true
    void api
      .get<DataSourceInfo[]>('/datasources')
      .then((list) => {
        if (alive) setDsList(list)
      })
      .catch(() => {
        /* 网络/权限失败：选择器不渲染即可 */
      })
    return () => {
      alive = false
    }
  }, [setDsList])

  if (!sessionId) {
    const createSession = async () => {
      try {
        const sid = await ensureSession()
        navigate(`/session/${sid}`)
      } catch {
        /* 忽略 */
      }
    }
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-8 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-secondary text-foreground">
          <MessageSquare size={22} />
        </div>
        <div>
          <p className="text-lg text-foreground">你想分析什么数据？</p>
          <p className="mt-1 text-[13px] text-muted-foreground">新建对话后开始提问，或直接从示例开始</p>
        </div>
        <button onClick={createSession} className="btn btn-primary">
          新建对话
        </button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col print:block">
      {nearContextLimit && (
        <div
          role="alert"
          className="shrink-0 border-b border-warning/40 bg-warning-bg px-6 py-1.5 text-center text-[11px] text-warning"
        >
          对话上下文已接近上限（约 {tokenEstimate.toLocaleString('zh-CN')} tokens），建议新建会话或总结当前分析要点。
        </div>
      )}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-8 py-5 print:h-auto print:overflow-visible"
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <p>试试这些示例问题：</p>
            <div className="flex flex-wrap justify-center gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.text}
                  onClick={() => {
                    forceScroll()
                    send(ex.prompt)
                  }}
                  className="rounded-full border bg-background px-4 py-1.5 text-sm hover:bg-accent"
                >
                  {ex.text}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <MessageList
            messages={messages}
            sending={sending}
            onRetry={() => {
              // 重试 = 重发最近一条用户消息（error block retryable 时）
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === 'user') {
                  const text = messages[i].blocks
                    .map((b) => String(b.content.text ?? ''))
                    .join('\n')
                  if (text) {
                    forceScroll()
                    send(text)
                  }
                  return
                }
              }
            }}
          />
        )}
      </div>
      <AttachmentDrafts />
      <Composer
        sessionId={sessionId}
        disabled={sending}
        onSend={(text) => {
          forceScroll()
          send(text)
        }}
      />
    </div>
  )
}
