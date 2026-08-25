/**
 * SSE 客户端（POST + fetch ReadableStream）。
 * 实现 docs/Block与协议规范.md 第 3 章：token / block_start / block_update /
 * block_end / task_status / error / done；id 单调递增；忽略注释（心跳）。
 */
import { getToken } from '@/lib/api'

export interface SSEFrame {
  event: string
  id: number
  data: Record<string, unknown>
}

export interface SSECallbacks {
  onOpen?: () => void
  onEvent?: (frame: SSEFrame) => void
  onError?: (err: Error) => void
  onClose?: () => void
}

export async function streamSSE(
  url: string,
  body: unknown,
  cb: SSECallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    throw new ApiSseError(`SSE 请求失败（HTTP ${res.status}）`, res.status)
  }

  cb.onOpen?.()
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastId = 0 // 记录已派发最大 id，供调用方丢弃乱序重放

  const dispatch = (chunk: string) => {
    for (const frame of chunk.split('\n\n')) {
      if (!frame.trim()) continue
      let event = 'message'
      let id = lastId
      const dataLines: string[] = []
      for (const line of frame.split('\n')) {
        if (line.startsWith(':')) continue // 心跳/注释
        const idx = line.indexOf(':')
        if (idx < 0) continue
        const field = line.slice(0, idx).trim()
        const value = line.slice(idx + 1).trim()
        if (field === 'event') event = value
        else if (field === 'id') id = Number(value) || lastId
        else if (field === 'data') dataLines.push(value)
      }
      const raw = dataLines.join('\n')
      if (!raw) continue
      let data: Record<string, unknown> = {}
      try {
        data = JSON.parse(raw) as Record<string, unknown>
      } catch {
        data = { content: raw }
      }
      lastId = Math.max(lastId, id)
      cb.onEvent?.({ event, id, data })
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        dispatch(chunk)
      }
    }
    // 收尾：处理未以空行结尾的残帧
    if (buffer.trim()) dispatch(buffer)
    cb.onClose?.()
  } catch (err) {
    if (signal?.aborted) {
      // 主动取消，不视为错误
    } else {
      cb.onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }
}

export class ApiSseError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiSseError'
    this.status = status
  }
}