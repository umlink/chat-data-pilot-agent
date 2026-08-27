/**
 * 浏览器通知（PRD 5.6）：长任务完成/失败提醒。
 * 权限需在用户手势中请求（Header 铃铛按钮）；granted 后自动发送。
 */

export function notifySupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

export function notifyPermission(): NotificationPermission {
  return notifySupported() ? Notification.permission : 'denied'
}

/** 请求通知权限（须由用户手势触发）；已授权/已拒绝直接返回当前状态 */
export async function ensureNotifyPermission(): Promise<NotificationPermission> {
  if (!notifySupported()) return 'denied'
  const p = Notification.permission
  if (p === 'granted' || p === 'denied') return p
  return Notification.requestPermission()
}

/** 发送通知；未授权或构造失败静默 */
export function notify(title: string, body: string): void {
  if (notifyPermission() !== 'granted') return
  try {
    // 不持有实例：仅展示，无需点击回调
    new Notification(title, { body, tag: 'datapilot-task' })
  } catch {
    /* 通知构造失败静默 */
  }
}
