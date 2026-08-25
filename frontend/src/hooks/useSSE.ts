import { useEffect, useRef } from 'react'
import { streamSSE } from '@/lib/sseClient'
import type { SSEFrame } from '@/lib/sseClient'

interface UseSSEOptions {
  enabled: boolean
  url: string
  body: unknown
  onEvent: (frame: SSEFrame) => void
  onError?: (err: Error) => void
  onClose?: () => void
}

/**
 * 订阅一个 POST-SSE 流。enabled 变 true 时建立连接，卸载或 url 变化时 Abort。
 * 断开重连由调用方按协议（先 REST 对齐终态再续订）处理。
 */
export function useSSE({ enabled, url, body, onEvent, onError, onClose }: UseSSEOptions) {
  const eventRef = useRef(onEvent)
  const closeRef = useRef(onClose)
  const errRef = useRef(onError)
  const bodyRef = useRef(body)

  // 以 effect 同步最新回调到 ref，避免订阅 effect 与渲染期访问 ref
  useEffect(() => {
    eventRef.current = onEvent
  })
  useEffect(() => {
    closeRef.current = onClose
  })
  useEffect(() => {
    errRef.current = onError
  })
  useEffect(() => {
    bodyRef.current = body
  })

  useEffect(() => {
    if (!enabled) return
    const ctrl = new AbortController()
    void streamSSE(
      url,
      bodyRef.current,
      {
        onEvent: (f) => eventRef.current(f),
        onClose: () => closeRef.current?.(),
        onError: (e) => errRef.current?.(e),
      },
      ctrl.signal,
    ).catch(() => {
      /* 已在 onError 中处理 */
    })
    return () => ctrl.abort()
  }, [enabled, url])
}