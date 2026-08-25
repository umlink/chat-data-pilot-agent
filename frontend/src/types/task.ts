/** 任务类型契约（docs/Block与协议规范.md 3.5）。 */

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'

export interface Task {
  id: string
  session_id?: string | null
  type: string
  status: TaskStatus
  progress: number
  current_step?: string | null
  error?: string | null
  result?: Record<string, unknown> | null
  created_at?: string
  completed_at?: string | null
}

/** SSE task_status 事件载荷 */
export interface TaskStatusEvent {
  task_id: string
  status: TaskStatus
  percent?: number
  current_step?: string
}