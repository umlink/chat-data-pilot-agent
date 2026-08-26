import { Suspense, lazy } from 'react'
import { Navigate, createBrowserRouter } from 'react-router-dom'
import { ChatArea } from '@/components/chat/ChatArea'
import { DataSourcePage } from '@/components/datasource/DataSourcePage'
import { LogsPage } from '@/components/logs/LogsPage'
import { TemplatesPage } from '@/components/template/TemplatesPage'
import { AppShell } from '@/routers/AppShell'
import { GuestOnly, RequireAuth } from '@/routers/guards'

// 配置页（Dialog/Select 等较重组件）路由级懒加载
const ConfigPage = lazy(() => import('@/components/config/ConfigPage').then((m) => ({ default: m.ConfigPage })))

/**
 * 路由表（路由相关定义统一收敛在 src/routers/）。
 * 页面：
 *   /             对话分析（默认，未选会话空态）
 *   /session/:id  会话工作台（每个会话独立路由，便于前进/后退/分享）
 *   /datasources 数据源管理
 *   /config      配置管理
 *   /logs        日志查看
 */
export const router = createBrowserRouter([
  { path: '/login', element: <GuestOnly /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <ChatArea /> },
      { path: 'session/:id', element: <ChatArea /> },
      {
        path: 'datasources',
        element: <DataSourcePage />,
      },
      {
        path: 'config',
        element: (
          <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">加载中…</div>}>
            <ConfigPage />
          </Suspense>
        ),
      },
      { path: 'logs', element: <LogsPage /> },
      { path: 'templates', element: <TemplatesPage /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
])