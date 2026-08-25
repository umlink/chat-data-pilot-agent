import { create } from 'zustand'
import type { Block, Message, SessionInfo } from '@/types/message'

interface ChatState {
  sessionId: string | null
  messages: Message[]
  sessions: SessionInfo[]
  sending: boolean

  setSessionId: (id: string | null) => void
  setMessages: (messages: Message[]) => void
  setSessions: (sessions: SessionInfo[]) => void
  setSending: (v: boolean) => void

  appendMessage: (msg: Message) => void
  /** 按 block.id upsert（新增或替换） */
  upsertBlock: (messageId: string, block: Block) => void
  /** JSON Merge Patch 风格浅合并到 block.content */
  patchBlock: (messageId: string, blockId: string, patch: Record<string, unknown>) => void
  /** text block 增量追加 */
  appendTextToken: (messageId: string, blockId: string, text: string) => void
  /** 更新 block 状态 */
  setBlockStatus: (messageId: string, blockId: string, status: Block['status']) => void
  setMessageMetadata: (messageId: string, patch: Record<string, unknown>) => void
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

export const useChatStore = create<ChatState>((set) => ({
  sessionId: null,
  messages: [],
  sessions: [],
  sending: false,

  setSessionId: (id) => set({ sessionId: id }),
  setMessages: (messages) => set({ messages }),
  setSessions: (sessions) => set({ sessions }),
  setSending: (v) => set({ sending: v }),

  appendMessage: (msg) =>
    set((s) => ({ messages: [...s.messages, msg] })),

  upsertBlock: (messageId, block) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId ? { ...m, blocks: updateBlockInList(m.blocks, block) } : m,
      ),
    })),

  patchBlock: (messageId, blockId, patch) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              blocks: m.blocks.map((b) =>
                b.id === blockId
                  ? { ...b, content: { ...b.content, ...patch } }
                  : b,
              ),
            }
          : m,
      ),
    })),

  appendTextToken: (messageId, blockId, text) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              blocks: m.blocks.map((b) =>
                b.id === blockId
                  ? {
                      ...b,
                      content: { ...b.content, text: String(b.content.text ?? '') + text },
                    }
                  : b,
              ),
            }
          : m,
      ),
    })),

  setBlockStatus: (messageId, blockId, status) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              blocks: m.blocks.map((b) => (b.id === blockId ? { ...b, status } : b)),
            }
          : m,
      ),
    })),

  setMessageMetadata: (messageId, patch) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId ? { ...m, metadata: { ...m.metadata, ...patch } } : m,
      ),
    })),
}))