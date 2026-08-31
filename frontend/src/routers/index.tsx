// oxlint-disable react/only-export-components -- 路由装配模块：本文件唯一导出是 router（非组件）；lazy 页面常量仅供模块内部使用，Fast Refresh 语义不适用于路由表
import { Suspense, lazy } from 'react'
import { Navigate, createBrowserRouter } from 'react-router-dom'
import { ChatArea } from '@/pages/chat/ChatArea'
import { DataSourcePage } from '@/pages/datasources/DataSourcePage'
import { LogsPage } from '@/pages/logs/LogsPage'
import { TemplatesPage } from '@/pages/templates/TemplatesPage'
import { AppShell } from '@/routers/AppShell'
import { GuestOnly, RequireAuth } from '@/routers/guards'

// 重页面（图表/表格/表单等较重组件）路由级懒加载
const ConfigPage = lazy(() => import('@/pages/config/ConfigPage').then((m) => ({ default: m.ConfigPage })))
const BoardPage = lazy(() =>
  import('@/pages/board/BoardPage').then((m) => ({ default: m.BoardPage })),
)
const ReportsPage = lazy(() => import('@/pages/reports/ReportsPage').then((m) => ({ default: m.ReportsPage })))
const AutomationPage = lazy(() =>
  import('@/pages/automations/AutomationPage').then((m) => ({ default: m.AutomationPage })),
)
const NotificationChannelsPage = lazy(() =>
  import('@/pages/notifications/NotificationChannelsPage').then((m) => ({
    default: m.NotificationChannelsPage,
  })),
)
const StatsPage = lazy(() =>
  import('@/pages/stats/StatsPage').then((m) => ({ default: m.StatsPage })),
)

/**
 * 路由表（路由相关定义统一收敛在 src/routers/）。
 * 页面：
 *   /             对话分析（默认，未选会话空态）
 *   /session/:id  会话工作台（每个会话独立路由，便于前进/后退/分享）
 *   /datasources 数据源管理
 *   /board       我的看板（收藏图表沉淀）
 *   /reports     定时报告
 *   /stats       Token 用量统计
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
        path: 'board',
        element: (
          <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">加载中…</div>}>
            <BoardPage />
          </Suspense>
        ),
      },
      {
        path: 'reports',
        element: (
          <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">加载中…</div>}>
            <ReportsPage />
          </Suspense>
        ),
      },
      {
        path: 'automations',
        element: (
          <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">加载中…</div>}>
            <AutomationPage />
          </Suspense>
        ),
      },
      {
        path: 'notifications',
        element: (
          <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">加载中…</div>}>
            <NotificationChannelsPage />
          </Suspense>
        ),
      },
      {
        path: 'stats',
        element: (
          <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">加载中…</div>}>
            <StatsPage />
          </Suspense>
        ),
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