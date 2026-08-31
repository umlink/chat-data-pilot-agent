import { create } from 'zustand'
import type { AttachmentContent, Block, Message, SessionInfo } from '@/types/message'

interface ChatState {
  /** 当前查看的会话 id（路由 /session/:id 同步） */
  sessionId: string | null
  /** 多会话消息缓存：会话切换不中断后台流，返回时可见已完成的结果 */
  messagesBySession: Record<string, Message[]>
  sessions: SessionInfo[]
  /** 每会话是否正在等待 SSE 回复（key=sessionId） */
  sending: Record<string, boolean>
  /** 附件草稿（上传成功但未发送；发送成功或移除后清掉），按会话隔离避免跨会话污染 */
  attachmentsBySession: Record<string, AttachmentContent[]>
  /** 会话级数据源选择（key=sessionId，'' = 未指定，走后端主数据源回退；契约 /chat/stream datasource_id） */
  datasourceBySession: Record<string, string>

  setSessionId: (id: string | null) => void
  /** 加载某会话历史（切换时调用） */
  setSessionMessages: (sessionId: string, messages: Message[]) => void
  /** 取当前会话消息数组（供组件 selector） */
  getCurrentMessages: () => Message[]
  setSessions: (updater: SessionInfo[] | ((prev: SessionInfo[]) => SessionInfo[])) => void
  setSending: (sessionId: string, v: boolean) => void
  /** 设置会话的数据源上下文（'' = 未指定） */
  setSessionDatasource: (sessionId: string, dsId: string) => void

  appendMessage: (sessionId: string, msg: Message) => void
  /** 按 id 整体替换单条消息（execute 决策后服务端返回完整 Message）；无则忽略 */
  replaceMessage: (sessionId: string, msg: Message) => void
  /** 替换消息 id（done 事件回写服务端真实 message_id，保证 feedback 等按 id 的操作可命中） */
  replaceMessageId: (sessionId: string, oldId: string, newId: string) => void
  /** 按 block.id upsert（新增或替换） */
  upsertBlock: (sessionId: string, messageId: string, block: Block) => void
  /** JSON Merge Patch 风格浅合并到 block.content */
  patchBlock: (sessionId: string, messageId: string, blockId: string, patch: Record<string, unknown>) => void
  /** text block 增量追加 */
  appendTextToken: (sessionId: string, messageId: string, blockId: string, text: string) => void
  /** 更新 block 状态 */
  setBlockStatus: (sessionId: string, messageId: string, blockId: string, status: Block['status']) => void
  setMessageMetadata: (sessionId: string, messageId: string, patch: Record<string, unknown>) => void

  addAttachment: (sessionId: string, attachment: AttachmentContent) => void
  updateAttachment: (sessionId: string, attachmentId: string, patch: Partial<AttachmentContent>) => void
  removeAttachment: (sessionId: string, attachmentId: string) => void
  clearAttachments: (sessionId: string) => void
}

function updateBlockInList(blocks: Block[], block: Block): Block[] {
  const idx = blocks.findIndex((b) => b.id === block.id)
  if (idx >= 0) {
    const copy = blocks.slice()
    copy[idx] = block
    return copy
  }
  return [...blocks, block]
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessionId: null,
  messagesBySession: {},
  sessions: [],
  sending: {},
  attachmentsBySession: {},
  datasourceBySession: {},

  setSessionId: (id) => set({ sessionId: id }),
  setSessionMessages: (sessionId, messages) =>
    set((s) => ({ messagesBySession: { ...s.messagesBySession, [sessionId]: messages } })),
  getCurrentMessages: () => {
    const sid = get().sessionId
    return sid ? get().messagesBySession[sid] ?? [] : []
  },
  setSessions: (updater) =>
    set((s) => ({ sessions: typeof updater === 'function' ? updater(s.sessions) : updater })),
  setSending: (sessionId, v) => set((s) => ({ sending: { ...s.sending, [sessionId]: v } })),
  setSessionDatasource: (sessionId, dsId) =>
    set((s) => ({ datasourceBySession: { ...s.datasourceBySession, [sessionId]: dsId } })),

  appendMessage: (sessionId, msg) =>
    set((s) => {
      const list = s.messagesBySession[sessionId] ?? []
      return { messagesBySession: { ...s.messagesBySession, [sessionId]: [...list, msg] } }
    }),

  replaceMessage: (sessionId, msg) =>
    set((s) => {
      const list = s.messagesBySession[sessionId]
      if (!list) return s
      return {
        messagesBySession: {
          ...s.messagesBySession,
          [sessionId]: list.map((m) => (m.id === msg.id ? msg : m)),
        },
      }
    }),

  replaceMessageId: (sessionId, oldId, newId) =>
    set((s) => {
      const list = s.messagesBySession[sessionId]
      if (!list) return s
      return {
        messagesBySession: {
          ...s.messagesBySession,
          [sessionId]: list.map((m) => (m.id === oldId ? { ...m, id: newId } : m)),
        },
      }
    }),

  upsertBlock: (sessionId, messageId, block) =>
    set((s) => {
      const list = s.messagesBySession[sessionId]
      if (!list) return s
      return {
        messagesBySession: {
          ...s.messagesBySession,
          [sessionId]: list.map((m) =>
            m.id === messageId ? { ...m, blocks: updateBlockInList(m.blocks, block) } : m,
          ),
        },
      }
    }),

  patchBlock: (sessionId, messageId, blockId, patch) =>
    set((s) => {
      const list = s.messagesBySession[sessionId]
      if (!list) return s
      return {
        messagesBySession: {
          ...s.messagesBySession,
          [sessionId]: list.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  blocks: m.blocks.map((b) =>
                    b.id === blockId ? { ...b, content: { ...b.content, ...patch } } : b,
                  ),
                }
              : m,
          ),
        },
      }
    }),

  appendTextToken: (sessionId, messageId, blockId, text) =>
    set((s) => {
      const list = s.messagesBySession[sessionId]
      if (!list) return s
      return {
        messagesBySession: {
          ...s.messagesBySession,
          [sessionId]: list.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  blocks: m.blocks.map((b) =>
                    b.id === blockId
                      ? { ...b, content: { ...b.content, text: String(b.content.text ?? '') + text } }
                      : b,
                  ),
                }
              : m,
          ),
        },
      }
    }),

  setBlockStatus: (sessionId, messageId, blockId, status) =>
    set((s) => {
      const list = s.messagesBySession[sessionId]
      if (!list) return s
      return {
        messagesBySession: {
          ...s.messagesBySession,
          [sessionId]: list.map((m) =>
            m.id === messageId
              ? { ...m, blocks: m.blocks.map((b) => (b.id === blockId ? { ...b, status } : b)) }
              : m,
          ),
        },
      }
    }),

  setMessageMetadata: (sessionId, messageId, patch) =>
    set((s) => {
      const list = s.messagesBySession[sessionId]
      if (!list) return s
      return {
        messagesBySession: {
          ...s.messagesBySession,
          [sessionId]: list.map((m) =>
            m.id === messageId ? { ...m, metadata: { ...m.metadata, ...patch } } : m,
          ),
        },
      }
    }),

  addAttachment: (sessionId, attachment) =>
    set((s) => ({
      attachmentsBySession: {
        ...s.attachmentsBySession,
        [sessionId]: [...(s.attachmentsBySession[sessionId] ?? []), attachment],
      },
    })),
  updateAttachment: (sessionId, attachmentId, patch) =>
    set((s) => ({
      attachmentsBySession: {
        ...s.attachmentsBySession,
        [sessionId]: (s.attachmentsBySession[sessionId] ?? []).map((a) =>
          a.attachment_id === attachmentId ? { ...a, ...patch } : a,
        ),
      },
    })),
  removeAttachment: (sessionId, attachmentId) =>
    set((s) => ({
      attachmentsBySession: {
        ...s.attachmentsBySession,
        [sessionId]: (s.attachmentsBySession[sessionId] ?? []).filter(
          (a) => a.attachment_id !== attachmentId,
        ),
      },
    })),
  clearAttachments: (sessionId) =>
    set((s) => ({
      attachmentsBySession: { ...s.attachmentsBySession, [sessionId]: [] },
    })),
}))
