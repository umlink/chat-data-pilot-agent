import { useEffect, useMemo } from 'react'
import { MessageSquare } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '@/lib/api'
import { useChatStore } from '@/store/chatStore'
import { cancelAllStreams, useChat } from '@/hooks/useChat'
import { useStickToBottom } from '@/hooks/useStickToBottom'
import { ensureSession } from '@/hooks/useAttachments'
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

  // 当前会话的消息 + sending（多会话隔离）。
  // 注意：selector 必须返回稳定引用，不能用 `?? []`（每次渲染新数组 → 无限循环）
  const rawMessages = useChatStore((s) => (sessionId ? s.messagesBySession[sessionId] : undefined))
  const sending = useChatStore((s) => (sessionId ? !!s.sending[sessionId] : false))
  const messages = useMemo(() => rawMessages ?? [], [rawMessages])

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
    void api
      .get<Message[]>(`/sessions/${id}/messages`)
      .then((msgs) => setSessionMessages(id, msgs))
      .catch(() => setSessionMessages(id, []))
  }, [id, sessionId, setSessionId, setSessionMessages])

  // 组件卸载（登出等）时取消所有流
  useEffect(() => () => cancelAllStreams(), [])

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
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 py-5">
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
          <MessageList messages={messages} sending={sending} />
        )}
      </div>
      <AttachmentDrafts />
      <Composer
        disabled={sending}
        onSend={(text) => {
          forceScroll()
          send(text)
        }}
      />
    </div>
  )
}
