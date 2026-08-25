import type { ReactElement } from 'react'
import { Navigate } from 'react-router-dom'
import { getToken } from '@/lib/api'
import { Login } from '@/components/auth/Login'

/** 已登录才可访问；未登录跳登录页 */
export function RequireAuth({ children }: { children: ReactElement }) {
  if (!getToken()) return <Navigate to="/login" replace />
  return children
}

/** 已登录访问登录页时直接回主界面 */
export function GuestOnly() {
  if (getToken()) return <Navigate to="/" replace />
  return <Login />
}