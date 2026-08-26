import { useCallback } from 'react'
import { API_BASE } from '@/lib/api'
import { streamSSE } from '@/lib/sseClient'
import type { SSEFrame } from '@/lib/sseClient'
import { useChatStore } from '@/store/chatStore'
import type { Block, BlockType, Message } from '@/types/message'

/**
 * 每会话一个 AbortController：
 * - 同一会话发新消息 → abort 旧流（防止重复/竞态）；
 * - 切换到别的会话 → 后台流继续（不 abort），切回时能看到已完成结果；
 * - 登出 → abort 全部（cancelAllStreams）。
 */
const controllers = new Map<string, AbortController>()

/** 登出/全局清理时取消所有进行中的 SSE 流 */
export function cancelAllStreams(): void {
  for (const ctrl of controllers.values()) ctrl.abort()
  controllers.clear()
}

/** 取消指定会话的流（会话删除时调用） */
export function cancelStream(sessionId: string): void {
  controllers.get(sessionId)?.abort()
  controllers.delete(sessionId)
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
 * 流按 sessionId 隔离：切换会话不中断后台流，同会话发新消息才 abort 旧流。
 */
export function useChat() {
  const send = useCallback(async (text: string) => {
    const st = useChatStore.getState()
    const sessionId = st.sessionId
    if (!sessionId) return
    if (st.sending[sessionId]) return
    // 草稿附件（attachment_id 列表）随消息发送
    const attachmentIds = st.attachments.map((a) => a.attachment_id)
    st.setSending(sessionId, true)

    const userMsg: Message = {
      id: uid(),
      session_id: sessionId,
      role: 'user',
      metadata: {},
      blocks: [{ id: uid(), type: 'text', status: 'completed', content: { text } }],
    }
    st.appendMessage(sessionId, userMsg)

    // 预置 assistant 消息：首个 text block 作为流式文本容器
    const msgId = uid()
    const textBlockId = uid()
    st.appendMessage(sessionId, {
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
          s.appendTextToken(sessionId, msgId, String(d.block_id), String(d.content ?? ''))
          break
        case 'block_start': {
          const type = (d.type as BlockType) ?? 'text'
          s.upsertBlock(sessionId, msgId, {
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
          s.patchBlock(sessionId, msgId, String(d.block_id), (d.patch as Record<string, unknown>) ?? {})
          break
        case 'block_end':
          s.setBlockStatus(sessionId, msgId, String(d.block_id), (d.status as Block['status']) ?? 'completed')
          break
        case 'task_status': {
          const cur = useChatStore.getState()
          const msg = cur.messagesBySession[sessionId]?.find((m) => m.id === msgId)
          const progress = msg?.blocks.find(
            (b) => b.type === 'progress' && b.content.task_id === d.task_id,
          )
          if (progress) {
            cur.patchBlock(sessionId, msgId, progress.id, {
              percent: (d.percent as number) ?? progress.content.percent ?? 0,
              current_step: d.current_step,
            })
          }
          break
        }
        case 'error':
          s.upsertBlock(sessionId, msgId, {
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
          s.setMessageMetadata(sessionId, msgId, { usage: d.usage ?? {} })
          s.setBlockStatus(sessionId, msgId, textBlockId, 'completed')
          s.setSending(sessionId, false)
          s.clearAttachments()
          break
        default:
          break
      }
    }

    // 同一会话的旧流 abort（防止竞态）；不同会话的流保留继续
    controllers.get(sessionId)?.abort()
    const ctrl = new AbortController()
    controllers.set(sessionId, ctrl)

    try {
      await streamSSE(
        `${API_BASE}/chat/stream`,
        {
          session_id: sessionId,
          message: text,
          text_block_id: textBlockId,
          ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
        },
        {
          onEvent: applyFrame,
          onError: (err) => {
            const s = useChatStore.getState()
            const blocks = s.messagesBySession[sessionId]?.find((m) => m.id === msgId)?.blocks
            const current =
              blocks?.find((b) => b.id === textBlockId)?.content.text ?? ''
            s.patchBlock(sessionId, msgId, textBlockId, {
              text: `${current}\n\n⚠️ 连接中断：${err.message}`,
            })
            s.setBlockStatus(sessionId, msgId, textBlockId, 'failed')
            s.setSending(sessionId, false)
          },
        },
        ctrl.signal,
      )
      useChatStore.getState().setSending(sessionId, false)
    } catch {
      useChatStore.getState().setSending(sessionId, false)
    } finally {
      if (controllers.get(sessionId) === ctrl) controllers.delete(sessionId)
    }
  }, [])

  return { send }
}
