import { useCallback, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * 滚动容器「贴底跟随」hook（消息流自动滚动，严谨版）：
 * - stick 语义：距底 < 48px（或容器高 15%）视为贴底；
 * - 贴底时 follow() 生效 → rAF 合帧滚到最底（流式 token 高频更新只触发一次，不抖动）；
 * - 用户上滑 → 暂停跟随（不打断看历史）；滑回底部自动恢复；
 * - forceScroll()：主动动作（发送消息/切换会话）后平滑滚底，并恢复贴底。
 *
 * 用法：
 *   const stick = useStickToBottom<HTMLDivElement>()
 *   useEffect(() => stick.follow(), [messages, sending])   // deps 由调用方字面量提供
 *   <div ref={stick.ref} .../>
 */
export function useStickToBottom<T extends HTMLElement>(): {
  ref: RefObject<T | null>
  follow: () => void
  forceScroll: () => void
} {
  const ref = useRef<T>(null)
  const stickRef = useRef(true)
  // 惰性绑定标记：容器可能在首帧后才挂载（空态 → 正式布局），首次滚动前补绑监听
  const boundRef = useRef(false)

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    stickRef.current = dist < Math.max(48, el.clientHeight * 0.15)
  }, [])

  // 惰性绑定滚动监听：容器挂载后首次 follow/forceScroll 时补绑，
  // 解决首帧容器不存在（空态）导致 useEffect([]) 监听永不绑定的问题
  const ensureBound = useCallback(() => {
    const el = ref.current
    if (!el || boundRef.current) return
    el.addEventListener('scroll', onScroll, { passive: true })
    boundRef.current = true
  }, [onScroll])

  /** 调用方在其 useEffect 中调用（内容变化时）：贴底才滚，rAF 合帧 */
  const follow = useCallback(() => {
    ensureBound()
    const el = ref.current
    if (!el || !stickRef.current) return
    const raf = requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight }) // auto：流式高频更新时平滑会抖
    })
    return () => cancelAnimationFrame(raf)
  }, [ensureBound])

  /** 主动贴底（发送/切换会话后），低频动作用平滑滚动 */
  const forceScroll = useCallback(() => {
    ensureBound()
    stickRef.current = true
    const el = ref.current
    if (!el) return
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    })
  }, [ensureBound])

  return { ref, follow, forceScroll }
}
