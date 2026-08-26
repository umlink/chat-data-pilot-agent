import { useCallback, useRef, useState, type ReactNode } from 'react'
import { Eye, EyeOff, FileText, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import {
  formatFileSize,
  removeAttachmentRemote,
  replaceOne,
  useAttachmentPolling,
} from '@/hooks/useAttachments'
import { useChatStore } from '@/store/chatStore'
import type { AttachmentContent } from '@/types/message'

interface Props {
  content: AttachmentContent
  /** 消息流上下文（草稿区不传）；替换/移除后用于更新消息内的 block */
  context?: { sessionId: string; messageId: string; blockId: string }
}

/** GET /api/upload/{id}/preview 响应 data */
interface PreviewResponse {
  columns: string[]
  rows: Record<string, unknown>[]
  row_count: number
  truncated: boolean
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

/** 附件操作按钮（PRD 3.1.5：预览 / 替换 / 移除，对应契约 BlockAction） */
function ActionButton({
  onClick,
  ariaLabel,
  title,
  children,
  disabled,
}: {
  onClick: () => void
  ariaLabel: string
  title: string
  children: ReactNode
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  )
}

/** 预览表格：前 N 行紧凑只读渲染（PRD 857 行：默认前 50 行，可滚动查看更多） */
function PreviewTable({ data }: { data: PreviewResponse }) {
  const { columns, rows, truncated } = data
  return (
    <div className="mt-2 max-h-72 overflow-auto rounded-md border bg-card">
      <table className="w-full border-collapse text-[11px]">
        <thead className="sticky top-0 z-10 bg-card">
          <tr>
            {columns.map((col) => (
              <th
                key={col}
                className="whitespace-nowrap border-b border-muted px-2.5 py-1.5 text-left font-medium text-muted-foreground"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-muted/50 last:border-0">
              {columns.map((col) => (
                <td key={col} className="whitespace-nowrap px-2.5 py-1 text-foreground">
                  {String(row[col] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <div className="sticky bottom-0 border-t bg-card px-2.5 py-1 text-center text-[10px] text-muted-foreground">
          仅展示前 {rows.length} 行，共 {data.row_count.toLocaleString()} 行（完整数据请通过 SQL 分析）
        </div>
      )}
    </div>
  )
}

/**
 * 消息流中的 attachment block（docs/UI设计规范.md 3.11 产物卡）：
 * - 状态展示（复用 AttachmentStatusView）；
 * - ready 后支持「预览 / 替换 / 移除」（PRD 3.1.5）：
 *   - 预览：拉取前 50 行内嵌展示；
 *   - 替换：上传新文件 → 引用切到新附件 → 轮询解析状态（关联分析自动更新）；
 *   - 移除：删除记录/对象/临时表，block 标记 removed。
 */
export function AttachmentBlock({ content, context }: Props) {
  const [previewing, setPreviewing] = useState(false)
  const [previewData, setPreviewData] = useState<PreviewResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const patchBlock = useChatStore((s) => s.patchBlock)
  const ready = content.status === 'ready'
  const removed = content.removed === true

  // 替换后的新附件轮询（状态 uploading/parsing 时激活；onUpdate 回填 block）
  const patchContent = useCallback(
    (patch: Partial<AttachmentContent>) => {
      if (!context) return
      patchBlock(context.sessionId, context.messageId, context.blockId, patch as Record<string, unknown>)
    },
    [context, patchBlock],
  )
  useAttachmentPolling(content.attachment_id, (content.status === 'uploading' || content.status === 'parsing') && !!context, patchContent)

  const togglePreview = async () => {
    if (previewing) {
      setPreviewing(false)
      return
    }
    setPreviewing(true)
    if (previewData) return
    setActionError('')
    try {
      const data = await api.get<PreviewResponse>(`/upload/${content.attachment_id}/preview`)
      setPreviewData(data)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '预览加载失败')
    }
  }

  const onPickReplaceFile = async (file: File | null) => {
    if (!file || !context) return
    setBusy(true)
    setActionError('')
    try {
      const data = await replaceOne(content.attachment_id, file, context.sessionId)
      // 引用切到新附件：重置解析相关字段，轮询解析状态
      patchContent({
        attachment_id: data.attachment_id,
        file_name: data.file_name,
        file_type: data.file_type,
        file_size: 0,
        status: 'uploading',
        sheet_name: undefined,
        row_count: undefined,
        columns: undefined,
        preview_rows: undefined,
        error: undefined,
        removed: false,
        replaced_by: undefined,
      })
      setPreviewing(false)
      setPreviewData(null)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '替换失败')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const onRemove = async () => {
    if (!context) return
    if (!window.confirm(`确定移除附件「${content.file_name}」吗？移除后该附件将无法用于分析。`)) return
    setBusy(true)
    setActionError('')
    try {
      await removeAttachmentRemote(content.attachment_id)
      patchContent({ removed: true, status: content.status === 'failed' ? 'failed' : 'ready', error: undefined })
      setPreviewing(false)
      setPreviewData(null)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '移除失败')
    } finally {
      setBusy(false)
    }
  }

  const canOperate = ready && !removed && !!context

  return (
    <div className="inline-flex max-w-full flex-col items-start gap-2 rounded-md border bg-card px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <AttachmentStatusView content={content} />
        {canOperate && (
          <div className="flex shrink-0 items-center gap-0.5">
            <ActionButton onClick={() => void togglePreview()} ariaLabel="预览附件数据" title={previewing ? '收起预览' : '预览前 50 行'} disabled={busy}>
              {previewing ? <EyeOff size={13} /> : <Eye size={13} />}
            </ActionButton>
            <ActionButton onClick={() => fileRef.current?.click()} ariaLabel="替换附件" title="替换附件（新文件）" disabled={busy}>
              <RefreshCw size={13} />
            </ActionButton>
            <ActionButton onClick={() => void onRemove()} ariaLabel="移除附件" title="移除附件" disabled={busy}>
              <Trash2 size={13} />
            </ActionButton>
          </div>
        )}
        {removed && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">已移除</span>
        )}
      </div>
      {actionError && <div className="text-[11px] text-error">{actionError}</div>}
      {previewing && previewData && <PreviewTable data={previewData} />}
      {canOperate && (
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx,.xls,.json"
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => void onPickReplaceFile(e.target.files?.[0] ?? null)}
        />
      )}
    </div>
  )
}

/** 附件状态展示（文件名 + 大小 + 状态点 + 就绪摘要 + 失败文案）；草稿卡与消息块共用 */
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
