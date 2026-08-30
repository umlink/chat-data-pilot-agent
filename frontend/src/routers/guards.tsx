import { useEffect, useState, type ReactElement } from 'react'
import { Navigate } from 'react-router-dom'
import { getToken, verifySession } from '@/lib/api'
import { Login } from '@/pages/login/Login'

type AuthState = 'checking' | 'authed' | 'guest'

/**
 * 登录态校验：本地 token 仅是开胃菜，服务端 /auth/me 才定音——
 * token 过期/失效（此时本地可能仍残留字符串）一律按 guest 处理，
 * 保证「需要登录时跳登录页、已登录不出现登录页」在真实会话下成立。
 */
function useAuthState(): AuthState {
  const [state, setState] = useState<AuthState>(() => (getToken() ? 'checking' : 'guest'))

  useEffect(() => {
    if (!getToken()) return
    let alive = true
    void verifySession().then((ok) => {
      if (alive) setState(ok ? 'authed' : 'guest')
    })
    return () => {
      alive = false
    }
  }, [])

  return state
}

/** 校验中转场：不放行也不闪登录页 */
function AuthSplash() {
  return (
    <div className="flex h-screen items-center justify-center bg-background" aria-label="校验登录状态">
      <div className="size-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
    </div>
  )
}

/** 已登录才可访问；未登录 / token 失效跳登录页 */
export function RequireAuth({ children }: { children: ReactElement }) {
  const state = useAuthState()
  if (state === 'checking') return <AuthSplash />
  if (state === 'guest') return <Navigate to="/login" replace />
  return children
}

/** 已登录访问登录页时直接回主界面；未登录 / 失效展示登录页 */
export function GuestOnly() {
  const state = useAuthState()
  if (state === 'checking') return <AuthSplash />
  if (state === 'authed') return <Navigate to="/" replace />
  return <Login />
}
