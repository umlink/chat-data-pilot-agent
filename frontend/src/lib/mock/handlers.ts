/**
 * Mock REST 路由（VITE_USE_MOCK=true 时由 api.ts 的 request() 先路由到此处）。
 * 命中返回数据；未命中返回 undefined，由调用方回落到真实 fetch。
 */
import type { SessionInfo } from '@/types/message'
import { store } from './data'

type MockBody = Record<string, unknown> | undefined
type Method = 'GET' | 'POST'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 未命中返回 undefined，代表该请求按真实路径发起 */
export async function mockRequest(
  path: string,
  method: Method,
  body: MockBody,
): Promise<unknown | undefined> {
  // 模拟网络延迟（180–420ms）
  await sleep(180 + Math.random() * 240)

  // 登录：mock 接受任意非空账号，返回虚拟 token
  if (method === 'POST' && path === '/auth/login') {
    const username = String((body as { username?: unknown } | undefined)?.username ?? 'admin')
    return {
      token: `mock-token-${Math.random().toString(16).slice(2)}`,
      user: { username },
    }
  }

  // 会话列表（返回拷贝，避免外部持有内部引用导致状态被变异污染）
  if (method === 'GET' && path === '/sessions') {
    return [...store.sessions]
  }

  // 新建会话（不可变地构造新数组，不用 in-place unshift）
  if (method === 'POST' && path === '/sessions') {
    const title = String((body as { title?: unknown } | undefined)?.title ?? '新对话')
    const s: SessionInfo = {
      id: `sd_${Math.random().toString(16).slice(2, 10)}`,
      title,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    store.sessions = [s, ...store.sessions]
    store.messagesBySession.set(s.id, [])
    return s
  }

  // 会话下消息（拷贝）
  const msgMatch = path.match(/^\/sessions\/([^/]+)\/messages$/)
  if (method === 'GET' && msgMatch) {
    return [...(store.messagesBySession.get(msgMatch[1]) ?? [])]
  }

  // 删除会话
  if (method === 'POST' && path === '/sessions/delete') {
    const id = String((body as { id?: unknown } | undefined)?.id ?? '')
    store.sessions = store.sessions.filter((s) => s.id !== id)
    store.messagesBySession.delete(id)
    return { ok: true }
  }

  return undefined
}