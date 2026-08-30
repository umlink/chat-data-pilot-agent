import { useCallback, useEffect, useState } from 'react'
import { API_BASE, ApiError, api, getToken } from '@/lib/api'
import { useChatStore } from '@/store/chatStore'
import type { AttachmentContent, SessionInfo } from '@/types/message'

/**
 * 附件上传（docs/Block与协议规范.md 第 5 章附件引擎）。
 * - POST /api/upload（multipart/form-data，必须 FormData 而非 JSON）→ 建 Attachment 记录 + file_parse 任务
 * - 附件状态由 GET /api/upload/{id}/status 轮询（2s，见 AttachmentDrafts 组件）
 */

/** POST /api/upload 响应 data（见 backend/app/api/upload.py） */
export interface UploadedAttachment {
  attachment_id: string
  task_id: string
  file_name: string
  file_type: 'csv' | 'excel' | 'json'
  object_key: string
  created_at?: string | null
  expires_at?: string | null
}

/** GET /api/upload/{id}/status 响应 data（见 backend/app/services/attachment_service.py get_status） */
export interface AttachmentStatusResponse {
  attachment_id: string
  session_id: string
  file_name: string
  file_type: 'csv' | 'excel' | 'json'
  status: 'uploading' | 'parsing' | 'ready' | 'failed'
  file_size: number | null
  error: string | null
  created_at?: string | null
  expires_at?: string | null
  parsed_schema?: {
    table_name?: string
    row_count?: number
    columns?: { name: string; dtype: string; sqlite_type?: string; original_name?: string }[]
    sheet_name?: string
  } | null
  task?: {
    task_id: string
    status: string
    progress: number
    current_step?: string | null
    error?: string | null
    created_at?: string | null
    completed_at?: string | null
  } | null
}

/** 确保存在会话：无则创建（POST /sessions）并写入 store，返回 session_id */
export async function ensureSession(): Promise<string> {
  const st = useChatStore.getState()
  if (st.sessionId) return st.sessionId
  const s = await api.post<SessionInfo>('/sessions', { title: '新对话' })
  st.setSessions([s, ...st.sessions])
  st.setSessionId(s.id)
  st.setSessionMessages(s.id, [])
  return s.id
}

/** 文件大小人类可读格式化（KB / MB） */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 单文件上传：FormData 直接 fetch（api.ts 的 JSON request 不适用于 multipart），解析统一信封 */
export async function uploadOne(file: File, sessionId: string): Promise<UploadedAttachment> {
  return multipartUpload('/upload', { file, session_id: sessionId })
}

/** 替换附件：上传新文件（POST /api/upload/{id}/replace），旧记录保留供历史溯源 */
export async function replaceOne(
  attachmentId: string,
  file: File,
  sessionId: string,
): Promise<UploadedAttachment> {
  return multipartUpload(`/upload/${attachmentId}/replace`, { file, session_id: sessionId })
}

/** 移除附件：删除记录 + MinIO 对象 + 临时表（POST /api/upload/delete，PRD 3.1.5） */
export async function removeAttachmentRemote(attachmentId: string): Promise<void> {
  await api.post<{ code: number }>('/upload/delete', { attachment_id: attachmentId })
}

/**
 * 持久化附件 block 状态（POST /api/upload/{id}/block-state）：
 * 替换/移除后写回 messages.blocks，保证刷新后状态不丢失（契约 6 章唯一事实源）。
 * patch 中 null 表示清空字段（替换后旧解析字段移除）。
 */
export async function updateAttachmentBlockState(
  attachmentId: string,
  messageId: string,
  blockId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await api.post<{ code: number }>(`/upload/${attachmentId}/block-state`, {
    message_id: messageId,
    block_id: blockId,
    patch,
  })
}

/** multipart 通用上传（JSON request 不适用，需显式 FormData + Authorization） */
async function multipartUpload(
  path: string,
  fields: Record<string, string | Blob>,
): Promise<UploadedAttachment> {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)

  const token = getToken()
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  })

  let payload: { code?: number; data?: UploadedAttachment; message?: string } | null = null
  try {
    // 显式类型（catch 内 typeof payload 会被收窄为 null）
    payload = (await res.json()) as { code?: number; data?: UploadedAttachment; message?: string } | null
  } catch {
    /* 错误体非 JSON，保留默认文案 */
  }
  if (!res.ok || payload === null || typeof payload.code !== 'number') {
    throw new ApiError(
      payload?.message || `上传失败（HTTP ${res.status}）`,
      res.status,
      payload?.code ?? res.status,
    )
  }
  if (payload.code !== 0) {
    throw new ApiError(payload.message || '上传失败', res.status, payload.code)
  }
  if (!payload.data?.attachment_id) {
    throw new ApiError('服务端响应缺少附件信息', res.status, -1)
  }
  return payload.data
}

/**
 * 附件解析状态轮询（2s，参考 GET /api/upload/{id}/status 契约）：
 * 状态为 uploading/parsing 时轮询直到 ready/failed，把解析结果通过 onUpdate 回填。
 * 草稿卡与消息流 attachment block（替换后）共用。
 */
export function useAttachmentPolling(
  attachmentId: string,
  active: boolean,
  onUpdate: (patch: Partial<AttachmentContent>) => void,
) {
  useEffect(() => {
    if (!active) return
    let alive = true
    let timer: ReturnType<typeof setInterval> | null = null
    const tick = async () => {
      try {
        const st = await api.get<AttachmentStatusResponse>(`/upload/${attachmentId}/status`)
        if (!alive) return
        onUpdate({
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
  }, [attachmentId, active, onUpdate])
}

/**
 * 附件上传动作：上传成功后写入 store 草稿区（附件解析状态由 AttachmentDrafts 轮询回填）。
 */
export function useAttachments() {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    setError('')
    setUploading(true)
    try {
      const sessionId = await ensureSession()
      for (const file of files) {
        const data = await uploadOne(file, sessionId)
        const draft: AttachmentContent = {
          attachment_id: data.attachment_id,
          file_name: data.file_name,
          file_type: data.file_type,
          file_size: 0, // 解析完成后由状态接口回填
          status: 'uploading',
        }
        useChatStore.getState().addAttachment(draft)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }, [])

  return { uploading, error, uploadFiles }
}
