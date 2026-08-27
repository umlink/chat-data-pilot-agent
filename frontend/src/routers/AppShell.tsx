import { Outlet, useNavigate } from 'react-router-dom'
import { clearToken } from '@/lib/api'
import { cancelAllStreams } from '@/hooks/useChat'
import { Header } from '@/components/layout/Header'
import { Sidebar } from '@/components/layout/Sidebar'

/** 已登录应用外壳：三栏布局 + 子路由出口（docs/UI设计规范.md 2） */
export function AppShell() {
  const navigate = useNavigate()
  const logout = () => {
    cancelAllStreams() // 登出时取消所有进行中的 SSE
    clearToken()
    navigate('/login', { replace: true })
  }

  return (
    <div className="flex h-full overflow-hidden bg-background text-foreground print:block print:h-auto print:overflow-visible">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col print:block">
        <Header onLogout={logout} />
        <main className="flex min-h-0 flex-1 flex-col print:block">
          <Outlet />
        </main>
      </div>
    </div>
  )
}