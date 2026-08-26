import { useCallback, useState } from 'react'
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
async function uploadOne(file: File, sessionId: string): Promise<UploadedAttachment> {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('session_id', sessionId)

  const token = getToken()
  const res = await fetch(`${API_BASE}/upload`, {
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
