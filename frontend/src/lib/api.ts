/**
 * API 客户端。统一响应格式 { code, data, message }（docs/技术方案设计 2.3）。
 * 非 0 的 code 或非 2xx 均抛 ApiError。
 * VITE_USE_MOCK=true 时先路由到 src/lib/mock（见 mock/index.ts）。
 */
import { USE_MOCK, mockRequest } from '@/lib/mock'

export { USE_MOCK }

export const API_BASE: string = import.meta.env.VITE_API_BASE ?? '/api'
const TOKEN_KEY = 'datapilot_token'
const USERNAME_KEY = 'datapilot_username'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export function getUsername(): string | null {
  return localStorage.getItem(USERNAME_KEY)
}

export function setUsername(name: string): void {
  localStorage.setItem(USERNAME_KEY, name)
}

/** 跳到登录页（401 自动登出用）；已在该页则不重复跳转 */
export function redirectToLogin(): void {
  if (window.location.pathname !== '/login') {
    window.location.replace('/login')
  }
}

/** 401 统一处理：携带 token 请求被拒 = token 失效/过期 → 清 token 回登录页（request 与下载/上传等直连复用） */
function handleUnauthorized(res: Response): void {
  if (res.status === 401 && getToken()) {
    clearToken()
    redirectToLogin()
  }
}

/**
 * 服务端校验当前 token：有效返回 true；401（失效/过期）清 token 返回 false。
 * 网络异常等非鉴权错误返回 true（后端临时不可达不该踢掉已登录用户，
 * 后续请求会各自给出错误提示）。
 */
export async function verifySession(): Promise<boolean> {
  if (!getToken()) return false
  try {
    await api.get('/auth/me', { auth: true })
    return true
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return false
    return true
  }
}

export class ApiError extends Error {
  code: number
  status: number

  constructor(message: string, status: number, code: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

interface ApiResponse<T> {
  code: number
  data: T
  message: string
}

interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  signal?: AbortSignal
  auth?: boolean
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, auth = true } = options

  // Mock 模式：命中则直接返回模拟数据；未命中回落到真实请求
  if (USE_MOCK) {
    const mocked = await mockRequest(path, method, body as Record<string, unknown> | undefined)
    if (mocked !== undefined) return mocked as T
  }

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (auth) {
    const token = getToken()
    if (token) headers.Authorization = `Bearer ${token}`
  }

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (e) {
    // 网络级失败（断网 / 后端未启动 / CORS）：裸 TypeError('Failed to fetch') 不可读，转中文提示
    if (e instanceof Error && e.name === 'AbortError') throw e
    throw new ApiError('网络异常：无法连接服务器，请检查网络或后端服务', 0, -1)
  }

  // 全局 401：携带 token 请求被拒 = token 失效/过期 → 清 token 回登录页
  // （登录接口自身 auth:false，不受影响）
  if (auth) handleUnauthorized(res)

  let payload: ApiResponse<T> | null = null
  try {
    payload = (await res.json()) as ApiResponse<T>
  } catch {
    throw new ApiError(`响应解析失败（HTTP ${res.status}）`, res.status, -1)
  }

  if (payload === null || typeof payload.code !== 'number') {
    throw new ApiError(`服务端响应格式异常（HTTP ${res.status}）`, res.status, -1)
  }
  if (payload.code !== 0) {
    throw new ApiError(payload.message || '请求失败', res.status, payload.code)
  }
  return payload.data
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>(path, { ...opts, method: 'GET' }),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: 'POST', body }),
}

interface DownloadOptions {
  /** 查询参数；logs/export 等 POST+query 类下载用 */
  query?: Record<string, string | number | boolean | undefined>
  /** 请求体（JSON）；export 等 POST+body 类下载用 */
  body?: unknown
  method?: 'GET' | 'POST'
}

/**
 * 带鉴权的二进制文件流下载（/api/export、/api/logs/export 返回 StreamingResponse，
 * 不走统一信封，见 docs/技术方案设计 2.3）。失败时尝试解析信封读取中文 message。
 */
export async function downloadFile(path: string, filename: string, opts: DownloadOptions = {}): Promise<void> {
  const usePost = opts.body !== undefined || opts.query !== undefined
  const method = opts.method ?? (usePost ? 'POST' : 'GET')

  let url = `${API_BASE}${path}`
  if (opts.query) {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== '') params.set(k, String(v))
    }
    const qs = params.toString()
    if (qs) url += `?${qs}`
  }

  const headers: Record<string, string> = { Accept: '*/*' }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`

  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
  } catch {
    throw new ApiError('网络异常：无法连接服务器，请检查网络或后端服务', 0, -1)
  }
  if (!res.ok) {
    // 下载类接口同样接入全局 401 登出
    handleUnauthorized(res)
    let message = `下载失败（HTTP ${res.status}）`
    try {
      const payload = (await res.json()) as { message?: string }
      if (payload?.message) message = payload.message
    } catch {
      /* 错误体非 JSON，保留默认文案 */
    }
    throw new ApiError(message, res.status, res.status)
  }

  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename || 'download'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(objectUrl)
}