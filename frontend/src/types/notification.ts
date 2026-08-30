/** 通知相关契约类型（镜像 backend/app/schemas/notification.py，见 CLAUDE.md 5.4）。 */

export type NotificationProvider = 'email' | 'feishu' | 'wecom' | 'dingtalk'

export interface ChannelInfo {
  id: string
  provider: NotificationProvider
  name: string
  /** 出参已掩码敏感字段 */
  config: Record<string, unknown>
  enabled: boolean
}

/** POST /api/notifications/send 返回（对话结果主动推送） */
export interface PushResult {
  ok: boolean
  log_id?: string
  error?: string | null
}

/** 发送记录（镜像 NotificationLogOut） */
export interface NotificationLogInfo {
  id: string
  channel_id: string | null
  subject: string | null
  body: string | null
  status: 'success' | 'failed'
  error: string | null
  created_at: string | null
}
