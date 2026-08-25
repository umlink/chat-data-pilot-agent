import { Outlet, useNavigate } from 'react-router-dom'
import { clearToken } from '@/lib/api'
import { Header } from '@/components/layout/Header'
import { Sidebar } from '@/components/layout/Sidebar'

/** 已登录应用外壳：三栏布局 + 子路由出口（docs/UI设计规范.md 2） */
export function AppShell() {
  const navigate = useNavigate()
  const logout = () => {
    clearToken()
    navigate('/login', { replace: true })
  }

  return (
    <div className="flex h-full overflow-hidden bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header onLogout={logout} />
        <main className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </main>
      </div>
    </div>
  )
}