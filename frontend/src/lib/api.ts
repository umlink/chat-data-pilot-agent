/**
 * API 客户端。统一响应格式 { code, data, message }（docs/技术方案设计 2.3）。
 * 非 0 的 code 或非 2xx 均抛 ApiError。
 */

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
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (auth) {
    const token = getToken()
    if (token) headers.Authorization = `Bearer ${token}`
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })

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