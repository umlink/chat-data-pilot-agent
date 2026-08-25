import { useEffect } from 'react'
import { api } from '@/lib/api'
import type { Task } from '@/types/task'

/**
 * 轮询任务状态（SSE 断开后的兜底对齐；见 docs/Block与协议规范.md 3.4）。
 */
export function useTaskPoll(taskId: string | null, onStatus: (task: Task) => void, intervalMs = 2000) {
  useEffect(() => {
    if (!taskId) return
    let timer: ReturnType<typeof setInterval> | null = null
    let alive = true
    const tick = async () => {
      try {
        const task = await api.get<Task>(`/tasks/${taskId}`)
        if (!alive) return
        onStatus(task)
        if (task.status === 'success' || task.status === 'failed' || task.status === 'cancelled') {
          if (timer) clearInterval(timer)
        }
      } catch {
        /* 轮询失败忽略，下轮重试 */
      }
    }
    void tick()
    timer = setInterval(tick, intervalMs)
    return () => {
      alive = false
      if (timer) clearInterval(timer)
    }
  }, [taskId, intervalMs, onStatus])
}