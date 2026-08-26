import { FileText, Loader2 } from 'lucide-react'
import { formatFileSize } from '@/hooks/useAttachments'
import type { AttachmentContent } from '@/types/message'

interface Props {
  content: AttachmentContent
}

/** 状态指示：uploading 转圈 / parsing 信息点 / ready 绿点 / failed 红点（语义 class，无裸色） */
function StatusIndicator({ status }: { status: AttachmentContent['status'] }) {
  switch (status) {
    case 'uploading':
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <Loader2 size={11} className="animate-spin" />
          上传中
        </span>
      )
    case 'parsing':
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <span className="status-dot running" />
          解析中
        </span>
      )
    case 'ready':
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-success">
          <span className="status-dot succeeded" />
          就绪
        </span>
      )
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-error">
          <span className="status-dot bg-error" />
          失败
        </span>
      )
  }
}

/** 就绪摘要：行数 / 列数 / 前几个列名（dtype） */
function ReadySummary({ content }: { content: AttachmentContent }) {
  const cols = content.columns ?? []
  const names = cols
    .slice(0, 3)
    .map((c) => `${c.name} (${c.dtype})`)
    .join('、')
  return (
    <div className="truncate text-[10px] text-muted-foreground">
      {content.row_count !== undefined ? `${content.row_count} 行 · ` : ''}
      {cols.length > 0 ? `${cols.length} 列 · ` : ''}
      {names}
      {cols.length > 3 ? '…' : ''}
    </div>
  )
}

/**
 * 附件状态展示（文件名 + 大小 + 状态点 + 就绪摘要 + 失败文案）。
 * 消息流内 attachment block 与 Composer 上方草稿卡共用。
 */
export function AttachmentStatusView({ content }: Props) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <FileText size={14} className="shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="max-w-[200px] truncate text-xs font-medium text-foreground">
            {content.file_name}
          </span>
          {content.status === 'ready' && content.file_size > 0 ? (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {formatFileSize(content.file_size)}
            </span>
          ) : null}
          <StatusIndicator status={content.status} />
        </div>
        {content.status === 'ready' ? <ReadySummary content={content} /> : null}
        {content.status === 'failed' && content.error ? (
          <div className="text-[11px] text-error">{content.error}</div>
        ) : null}
      </div>
    </div>
  )
}

/** 消息流中的 attachment block：产物式小卡（docs/UI设计规范.md 3.11 / 4） */
export function AttachmentBlock({ content }: Props) {
  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded-md border bg-card px-3 py-2">
      <AttachmentStatusView content={content} />
    </div>
  )
}
