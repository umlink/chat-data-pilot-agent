import { useCallback, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * 滚动容器「贴底跟随」hook（消息流自动滚动，用户操作优先版）：
 *
 * 语义：
 * - stick：是否「贴底跟随」。贴底时新内容到达自动滚到最底；
 * - 用户操作优先：任何用户滚动（wheel/touch/滚动条拖拽等）期间，程序一律**不抢滚**；
 *   用户上翻查看历史 → 解除贴底，后续流式新内容到达不打断阅读；
 *   用户滚回底部 → 自动恢复贴底；
 * - 程序化滚动（follow/forceScroll）不会触发「用户已上翻」误判。
 *
 * 时机严谨性（防抽搐卡顿）：
 * - `userInteract`：wheel/touchstart/pointerdown 标记用户手势，手势期间 follow() 直接跳过；
 * - `stick` 仅在用户手势产生的滚动事件里更新（程序化滚动不改 stick），避免边界抖动；
 * - setTimeout 合帧 + 单飞（pending 合并）：高频 token 更新只触发一次滚动，不与用户手势抢帧。
 *   不用 requestAnimationFrame：后台标签页 rAF 被暂停，流式时用户切走再切回会出现「pending 卡死」，
 *   setTimeout(0) 在后台也照常触发（Chrome 节流为 ~1s/次，恰好低频兜底滚底，回来看时已到位）。
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
  // 是否贴底（跟随）；仅在用户滚动事件里更新
  const stickRef = useRef(true)
  // 用户是否正在滚动手势中（手势期间程序不抢滚）
  const userInteractRef = useRef(false)
  // 用户手势结束后的防抖定时器（滚动事件可能高频连续到达）
  const endTimerRef = useRef<number | null>(null)
  // 惰性绑定标记：容器可能在首帧后才挂载，首次滚动前补绑监听
  const boundRef = useRef(false)
  // 合帧：待执行的滚底任务句柄，单飞防重复
  const timerRef = useRef<number | null>(null)

  const isNearBottom = useCallback((el: T): boolean => {
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    return dist < Math.max(48, el.clientHeight * 0.15)
  }, [])

  const endUserGesture = useCallback(() => {
    if (endTimerRef.current !== null) clearTimeout(endTimerRef.current)
    endTimerRef.current = null
    userInteractRef.current = false
    const el = ref.current
    if (el) stickRef.current = isNearBottom(el)
  }, [isNearBottom])

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    // 仅用户手势产生的滚动更新 stick：上翻解除跟随、滚回底部恢复跟随；
    // 程序化滚动不改 stick，避免「滚到底」事件把边界状态来回翻转造成抖动。
    if (userInteractRef.current) {
      stickRef.current = isNearBottom(el)
    }
  }, [isNearBottom])

  const onUserGestureStart = useCallback(() => {
    userInteractRef.current = true
    if (endTimerRef.current !== null) clearTimeout(endTimerRef.current)
    // 手势结束后（停止滚动 200ms）再评估是否贴底，期间程序不抢滚
    endTimerRef.current = window.setTimeout(endUserGesture, 200)
  }, [endUserGesture])

  const ensureBound = useCallback(() => {
    const el = ref.current
    if (!el || boundRef.current) return
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onUserGestureStart, { passive: true })
    el.addEventListener('touchstart', onUserGestureStart, { passive: true })
    el.addEventListener('pointerdown', onUserGestureStart, { passive: true })
    if ('onscrollend' in el) {
      el.addEventListener('scrollend', endUserGesture)
    }
    boundRef.current = true
  }, [onScroll, onUserGestureStart, endUserGesture])

  /** 调用方在其 useEffect 中调用（内容变化时）：贴底才滚，合帧单飞 */
  const follow = useCallback(() => {
    ensureBound()
    const el = ref.current
    // 用户手势中：绝对不抢滚（用户操作优先级最高）
    if (!el || userInteractRef.current) return
    if (!stickRef.current) return
    if (timerRef.current !== null) return // 已有待执行的滚底任务
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      const target = ref.current
      if (target && stickRef.current && !userInteractRef.current) {
        target.scrollTo({ top: target.scrollHeight }) // auto：流式高频更新时平滑会抖
      }
    }, 0)
  }, [ensureBound])

  /** 主动贴底（发送/切换会话后），低频动作用平滑滚动 */
  const forceScroll = useCallback(() => {
    ensureBound()
    // 主动动作：重置用户手势标记（防旧防抖把这次程序化滚动误判为用户手势）
    if (endTimerRef.current !== null) clearTimeout(endTimerRef.current)
    endTimerRef.current = null
    userInteractRef.current = false
    stickRef.current = true
    const el = ref.current
    if (!el) return
    window.setTimeout(() => {
      const target = ref.current
      if (target) target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' })
    }, 0)
  }, [ensureBound])

  return { ref, follow, forceScroll }
}
