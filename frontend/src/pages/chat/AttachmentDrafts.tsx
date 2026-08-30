import { useCallback, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { removeAttachmentRemote, useAttachmentPolling } from './useAttachments'
import { useChatStore } from '@/store/chatStore'
import type { AttachmentContent } from '@/types/message'
import { AttachmentStatusView } from './AttachmentBlock'

/**
 * 单个草稿附件：轮询 GET /api/upload/{id}/status（2s）直到 ready/failed，回填解析状态；
 * 移除时调用后端删除（记录 + MinIO 对象 + 临时表），失败也先本地移除。
 */
function DraftCard({ draft }: { draft: AttachmentContent }) {
  const updateAttachment = useChatStore((s) => s.updateAttachment)
  const removeAttachment = useChatStore((s) => s.removeAttachment)
  const [removing, setRemoving] = useState(false)
  const polling = draft.status === 'uploading' || draft.status === 'parsing'

  const onUpdate = useCallback(
    (patch: Partial<AttachmentContent>) => updateAttachment(draft.attachment_id, patch),
    [updateAttachment, draft.attachment_id],
  )
  useAttachmentPolling(draft.attachment_id, polling, onUpdate)

  const onRemove = async () => {
    if (removing) return
    setRemoving(true)
    try {
      await removeAttachmentRemote(draft.attachment_id)
    } catch {
      /* 删除失败不阻断：草稿区移除是本地动作，MinIO 对象由过期清理兜底 */
    } finally {
      removeAttachment(draft.attachment_id)
    }
  }

  return (
    <div className="flex max-w-full items-center gap-1 rounded-lg border bg-card py-1.5 pl-3 pr-1.5">
      <AttachmentStatusView content={draft} />
      <button
        onClick={() => void onRemove()}
        disabled={removing}
        aria-label={`移除附件 ${draft.file_name}`}
        title="从草稿区移除附件"
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-wait disabled:opacity-40"
      >
        {removing ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
      </button>
    </div>
  )
}

/** 附件草稿区：Composer 上方右对齐的卡片式小面板（docs/UI设计规范.md 3.11 产物卡） */
export function AttachmentDrafts() {
  const attachments = useChatStore((s) => s.attachments)
  if (attachments.length === 0) return null
  return (
    <div className="flex shrink-0 flex-col items-end gap-1.5 px-6 pb-1.5 print:hidden">
      {attachments.map((a) => (
        <DraftCard key={a.attachment_id} draft={a} />
      ))}
    </div>
  )
}
