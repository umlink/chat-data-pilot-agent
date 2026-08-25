import { Bot } from 'lucide-react'
import type { Message } from '@/types/message'
import { BlockViewer } from './BlockViewer'

/** 消息流：用户气泡（深色右对齐） + AI 消息（头像+名称+Block 流） （docs/UI设计规范.md 3.4） */
export function MessageList({ messages, sending }: { messages: Message[]; sending: boolean }) {
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
                    <BlockViewer key={b.id} block={b} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}