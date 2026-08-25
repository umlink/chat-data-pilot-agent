import { useCallback } from 'react'
import { API_BASE } from '@/lib/api'
import { streamSSE } from '@/lib/sseClient'
import type { SSEFrame } from '@/lib/sseClient'
import { useChatStore } from '@/store/chatStore'
import type { Block, BlockType, Message } from '@/types/message'

let activeController: AbortController | null = null

/** 取消进行中的 SSE 流（会话切换 / 登出时调用，协议要求见 CLAUDE.md 5.4） */
export function cancelRunningStream(): void {
  activeController?.abort()
  activeController = null
}

function uid(): string {
  return crypto.randomUUID()
}

function defaultBlockContent(type: BlockType): Record<string, unknown> {
  switch (type) {
    case 'text':
      return { text: '' }
    case 'code':
      return { language: 'sql', code: '', editable: true }
    case 'progress':
      return { task_id: '', steps: [], percent: 0, cancellable: true }
    case 'error':
      return { code: 'INTERNAL_ERROR', message: '', retryable: false }
    default:
      return {}
  }
}

/**
 * 发送一条消息并消费 /api/chat/stream 的 SSE 事件，按协议映射到 Block 流。
 * 事件契约见 docs/Block与协议规范.md 第 3 章。
 */
export function useChat() {
  const send = useCallback(async (text: string) => {
    const st = useChatStore.getState()
    if (st.sending || !st.sessionId) return
    const sessionId = st.sessionId
    st.setSending(true)

    const userMsg: Message = {
      id: uid(),
      session_id: sessionId,
      role: 'user',
      metadata: {},
      blocks: [{ id: uid(), type: 'text', status: 'completed', content: { text } }],
    }
    st.appendMessage(userMsg)

    // 预置 assistant 消息：首个 text block 作为流式文本容器
    const msgId = uid()
    const textBlockId = uid()
    st.appendMessage({
      id: msgId,
      session_id: sessionId,
      role: 'assistant',
      metadata: {},
      blocks: [{ id: textBlockId, type: 'text', status: 'running', content: { text: '' } }],
    })

    const applyFrame = (frame: SSEFrame) => {
      const s = useChatStore.getState()
      const d = frame.data
      switch (frame.event) {
        case 'token':
          s.appendTextToken(msgId, String(d.block_id), String(d.content ?? ''))
          break
        case 'block_start': {
          const type = (d.type as BlockType) ?? 'text'
          s.upsertBlock(msgId, {
            id: String(d.block_id),
            type,
            status: 'running',
            content: {
              ...defaultBlockContent(type),
              ...((d.content as Record<string, unknown>) ?? {}),
            },
            ...(d.actions ? { actions: d.actions as Block['actions'] } : {}),
          })
          break
        }
        case 'block_update':
          s.patchBlock(msgId, String(d.block_id), (d.patch as Record<string, unknown>) ?? {})
          break
        case 'block_end':
          s.setBlockStatus(msgId, String(d.block_id), (d.status as Block['status']) ?? 'completed')
          break
        case 'task_status': {
          const cur = useChatStore.getState()
          const msg = cur.messages.find((m) => m.id === msgId)
          const progress = msg?.blocks.find(
            (b) => b.type === 'progress' && b.content.task_id === d.task_id,
          )
          if (progress) {
            cur.patchBlock(msgId, progress.id, {
              percent: (d.percent as number) ?? progress.content.percent ?? 0,
              current_step: d.current_step,
            })
          }
          break
        }
        case 'error':
          s.upsertBlock(msgId, {
            id: uid(),
            type: 'error',
            status: 'completed',
            content: {
              code: d.code ?? 'INTERNAL_ERROR',
              message: String(d.message ?? '请求失败'),
              retryable: false,
            },
          })
          break
        case 'done':
          s.setMessageMetadata(msgId, { usage: d.usage ?? {} })
          s.setBlockStatus(msgId, textBlockId, 'completed')
          s.setSending(false)
          break
        default:
          break
      }
    }

    const ctrl = new AbortController()
    activeController?.abort()
    activeController = ctrl

    try {
      await streamSSE(
        `${API_BASE}/chat/stream`,
        // text_block_id：客户端预置的流式文本容器，服务端 token 事件据此定位。
        // （mock 环境由 lib/mock 消费；正式后端 M2 对齐时按此契约实现）
        { session_id: sessionId, message: text, text_block_id: textBlockId },
        {
          onEvent: applyFrame,
          onError: (err) => {
            const s = useChatStore.getState()
            const current =
              s.messages.find((m) => m.id === msgId)?.blocks.find((b) => b.id === textBlockId)
                ?.content.text ?? ''
            s.patchBlock(msgId, textBlockId, { text: `${current}\n\n⚠️ 连接中断：${err.message}` })
            s.setBlockStatus(msgId, textBlockId, 'failed')
            s.setSending(false)
          },
        },
        ctrl.signal,
      )
      useChatStore.getState().setSending(false)
    } catch {
      useChatStore.getState().setSending(false)
    } finally {
      if (activeController === ctrl) activeController = null
    }
  }, [])

  return { send }
}