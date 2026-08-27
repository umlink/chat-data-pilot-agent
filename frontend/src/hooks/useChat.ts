import { useCallback } from 'react'
import { API_BASE } from '@/lib/api'
import { notify } from '@/lib/notify'
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

/** 长任务浏览器通知（PRD 5.6）：记录任务首次出现时间，终态且耗时超阈值才通知 */
const taskStartedAt = new Map<string, number>()
const LONG_TASK_MS = 10_000

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
    // 会话级数据源上下文（'' 不传，走后端主数据源回退）
    const datasourceId = st.datasourceBySession[sessionId]
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

    // token 缓冲：契约 6.3 要求 50ms / 10 token 批量 flush，避免高频 setState。
    // 10 token 按 _estimate_tokens 口径 ≈ 40 中文字符（len/2），达到即提前 flush。
    const tokenBuf = new Map<string, string>()
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const flushTokens = () => {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      const s = useChatStore.getState()
      tokenBuf.forEach((text, blockId) => {
        if (text) s.appendTextToken(sessionId, msgId, blockId, text)
      })
      tokenBuf.clear()
    }
    const pushToken = (blockId: string, chunk: string) => {
      const cur = (tokenBuf.get(blockId) ?? '') + chunk
      tokenBuf.set(blockId, cur)
      if (cur.length >= 40) flushTokens()
      else if (!flushTimer) flushTimer = setTimeout(flushTokens, 50)
    }

    const applyFrame = (frame: SSEFrame) => {
      const s = useChatStore.getState()
      const d = frame.data
      switch (frame.event) {
        case 'token':
          pushToken(String(d.block_id), String(d.content ?? ''))
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
          // 任务起点：progress block 创建时间 ≈ 任务开始时间（通知长任务用）
          if (type === 'progress') {
            const taskId = (d.content as Record<string, unknown> | undefined)?.task_id
            if (taskId) taskStartedAt.set(String(taskId), Date.now())
          }
          break
        }
        case 'block_update':
          s.patchBlock(sessionId, msgId, String(d.block_id), (d.patch as Record<string, unknown>) ?? {})
          break
        case 'block_end':
          flushTokens()
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
            // 终态：取消/失败写入 content 标记（block_end 会覆写 status 为 completed，
            // 不能依赖 block.status 判断取消态，PRD 补充「任务取消」）
            const st = String(d.status ?? '')
            if (st === 'cancelled') {
              cur.patchBlock(sessionId, msgId, progress.id, { cancelled: true, cancellable: false })
              cur.setBlockStatus(sessionId, msgId, progress.id, 'cancelled')
            } else if (st === 'failed') {
              cur.patchBlock(sessionId, msgId, progress.id, {
                failed: true,
                cancellable: false,
                error: d.error ?? progress.content.error,
              })
              cur.setBlockStatus(sessionId, msgId, progress.id, 'failed')
            }
            // 长任务浏览器通知：耗时超阈值且已授权才提醒
            const now = Date.now()
            if (st === 'running' || st === 'pending') {
              if (!taskStartedAt.has(String(d.task_id))) taskStartedAt.set(String(d.task_id), now)
            } else if (st === 'success' || st === 'cancelled' || st === 'failed') {
              const started = taskStartedAt.get(String(d.task_id))
              taskStartedAt.delete(String(d.task_id))
              if (started !== undefined && now - started >= LONG_TASK_MS) {
                notify(
                  st === 'success' ? '任务完成' : st === 'cancelled' ? '任务已取消' : '任务失败',
                  st === 'failed'
                    ? String(d.error ?? '') || '任务执行失败，请查看对话详情'
                    : String(progress.content.current_step ?? '') || '后台任务已结束',
                )
              }
            }
          }
          break
        }
        case 'error':
          flushTokens()
          s.upsertBlock(sessionId, msgId, {
            id: uid(),
            type: 'error',
            status: 'completed',
            content: {
              code: d.code ?? 'INTERNAL_ERROR',
              message: String(d.message ?? '请求失败'),
              retryable: d.retryable === true,
            },
          })
          break
        case 'done': {
          flushTokens()
          const realId = String(d.message_id ?? '')
          s.setMessageMetadata(sessionId, msgId, { usage: d.usage ?? {} })
          // 服务端最终文本（已剥离澄清/追问选项段）覆盖实时流式文本，保证实时与落库一致
          if (typeof d.text === 'string' && d.text) {
            s.patchBlock(sessionId, msgId, textBlockId, { text: d.text })
          }
          s.setBlockStatus(sessionId, msgId, textBlockId, 'completed')
          s.setSending(sessionId, false)
          s.clearAttachments()
          // 回写服务端真实 message_id：保证后续 feedback / execute 按 id 操作可命中（此前用乐观 id 会 404）
          if (realId && realId !== msgId) s.replaceMessageId(sessionId, msgId, realId)
          break
        }
        default:
          break
      }
    }

    // 同一会话的旧流 abort（防止竞态）；不同会话的流保留继续
    controllers.get(sessionId)?.abort()
    const ctrl = new AbortController()
    controllers.set(sessionId, ctrl)

    // 断线重连（幂等）：仅当连接建立后未收到任何业务事件时自动重连一次，
    // 携带 client_msg_id 由后端幂等去重，避免重复落库/重复执行
    let receivedAny = false
    let lastError: Error | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      lastError = null
      try {
        await streamSSE(
          `${API_BASE}/chat/stream`,
          {
            session_id: sessionId,
            message: text,
            text_block_id: textBlockId,
            client_msg_id: userMsg.id,
            ...(datasourceId ? { datasource_id: datasourceId } : {}),
            ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
          },
          {
            onEvent: (frame) => {
              receivedAny = true
              applyFrame(frame)
            },
            onError: (err) => {
              lastError = err
            },
          },
          ctrl.signal,
        )
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
      }
      if (!lastError) break // 正常完成（含服务端 error 事件，属业务结束）
      if (receivedAny || attempt === 1) {
        // 已收到过事件（服务端已开始处理）或重连仍失败 → 按连接中断处理
        flushTokens()
        const s = useChatStore.getState()
        const blocks = s.messagesBySession[sessionId]?.find((m) => m.id === msgId)?.blocks
        const current = blocks?.find((b) => b.id === textBlockId)?.content.text ?? ''
        s.patchBlock(sessionId, msgId, textBlockId, {
          text: `${current}\n\n⚠️ 连接中断：${lastError.message}`,
        })
        s.setBlockStatus(sessionId, msgId, textBlockId, 'failed')
        break
      }
      // 零事件断线：等待后重连一次
      receivedAny = false
      await new Promise((r) => setTimeout(r, 600))
    }
    flushTokens()
    useChatStore.getState().setSending(sessionId, false)
    if (controllers.get(sessionId) === ctrl) controllers.delete(sessionId)
  }, [])

  return { send }
}
