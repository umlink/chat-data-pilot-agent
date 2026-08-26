import { useEffect } from 'react'
import { X } from 'lucide-react'
import { api } from '@/lib/api'
import type { AttachmentStatusResponse } from '@/hooks/useAttachments'
import { useChatStore } from '@/store/chatStore'
import type { AttachmentContent } from '@/types/message'
import { AttachmentStatusView } from './AttachmentBlock'

/**
 * 单个草稿附件：轮询 GET /api/upload/{id}/status（2s）直到 ready/failed，
 * 回填 store 中的解析状态（写法参考 useTaskPoll）。
 */
function DraftCard({ draft }: { draft: AttachmentContent }) {
  const updateAttachment = useChatStore((s) => s.updateAttachment)
  const removeAttachment = useChatStore((s) => s.removeAttachment)
  const polling = draft.status === 'uploading' || draft.status === 'parsing'

  useEffect(() => {
    if (!polling) return
    let alive = true
    let timer: ReturnType<typeof setInterval> | null = null
    const tick = async () => {
      try {
        const st = await api.get<AttachmentStatusResponse>(`/upload/${draft.attachment_id}/status`)
        if (!alive) return
        updateAttachment(draft.attachment_id, {
          status: st.status,
          file_size: st.file_size ?? 0,
          error: st.error ?? undefined,
          sheet_name: st.parsed_schema?.sheet_name,
          row_count: st.parsed_schema?.row_count,
          columns: st.parsed_schema?.columns?.map(({ name, dtype }) => ({ name, dtype })),
        })
      } catch {
        /* 轮询失败忽略，下轮重试 */
      }
    }
    void tick()
    timer = setInterval(tick, 2000)
    return () => {
      alive = false
      if (timer) clearInterval(timer)
    }
  }, [draft.attachment_id, polling, updateAttachment])

  return (
    <div className="flex max-w-full items-center gap-1 rounded-lg border bg-card py-1.5 pl-3 pr-1.5">
      <AttachmentStatusView content={draft} />
      <button
        onClick={() => removeAttachment(draft.attachment_id)}
        aria-label={`移除附件 ${draft.file_name}`}
        title="从草稿区移除（MinIO 对象暂不删除，MVP）"
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X size={13} />
      </button>
    </div>
  )
}

/** 附件草稿区：Composer 上方右对齐的卡片式小面板（docs/UI设计规范.md 3.11 产物卡） */
export function AttachmentDrafts() {
  const attachments = useChatStore((s) => s.attachments)
  if (attachments.length === 0) return null
  return (
    <div className="flex shrink-0 flex-col items-end gap-1.5 px-6 pb-1.5">
      {attachments.map((a) => (
        <DraftCard key={a.attachment_id} draft={a} />
      ))}
    </div>
  )
}
