import { MessageSquare } from 'lucide-react'
import { api } from '@/lib/api'
import { useChatStore } from '@/store/chatStore'
import { useChat } from '@/hooks/useChat'
import type { SessionInfo } from '@/types/message'
import { MessageList } from './MessageList'
import { Composer } from './Composer'

const EXAMPLES = [
  { text: '按月份统计销售额趋势', prompt: '请根据当前数据源，按月份统计销售额趋势。' },
  { text: '哪些客户贡献了大部分收入', prompt: '请分析哪些客户贡献了大部分收入，并给出占比。' },
  { text: '主要指标对比近三个月', prompt: '请对比近三个月的核心业务指标变化。' },
]

/** 中栏对话区：消息流 + 空状态 + 输入区（docs/UI设计规范.md 2 / 3.12） */
export function ChatArea() {
  const messages = useChatStore((s) => s.messages)
  const sending = useChatStore((s) => s.sending)
  const sessionId = useChatStore((s) => s.sessionId)
  const setSessions = useChatStore((s) => s.setSessions)
  const setSessionId = useChatStore((s) => s.setSessionId)
  const setMessages = useChatStore((s) => s.setMessages)
  const { send } = useChat()

  if (!sessionId) {
    const createSession = async () => {
      try {
        const s = await api.post<SessionInfo>('/sessions', { title: '新对话' })
        setSessions([s])
        setSessionId(s.id)
        setMessages([])
      } catch {
        /* 后端未实现时忽略 */
      }
    }
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-8 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-secondary text-foreground">
          <MessageSquare size={22} />
        </div>
        <div>
          <p className="text-lg text-foreground">你想分析什么数据？</p>
          <p className="mt-1 text-[13px] text-muted-foreground">新建对话后开始提问，或直接从示例问题开始</p>
        </div>
        <button onClick={createSession} className="btn btn-primary">
          新建对话
        </button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 消息流 */}
      <div className="flex-1 overflow-y-auto px-8 py-5">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <p>试试这些示例问题：</p>
            <div className="flex flex-wrap justify-center gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.text}
                  onClick={() => send(ex.prompt)}
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
      {/* 输入区 */}
      <Composer disabled={sending} onSend={send} />
    </div>
  )
}