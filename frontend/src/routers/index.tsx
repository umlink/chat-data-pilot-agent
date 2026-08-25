import { Navigate, createBrowserRouter } from 'react-router-dom'
import { Placeholder } from '@/components/common/Placeholder'
import { ChatArea } from '@/components/chat/ChatArea'
import { AppShell } from '@/routers/AppShell'
import { GuestOnly, RequireAuth } from '@/routers/guards'

/**
 * 路由表（路由相关定义统一收敛在 src/routers/）。
 * 页面：
 *   /            对话分析（默认）
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
      {
        path: 'datasources',
        element: <Placeholder title="数据源管理" note="新建 / 编辑 / 测试连接（M3）" />,
      },
      { path: 'config', element: <Placeholder title="配置管理" note="LLM 与系统配置（M1）" /> },
      { path: 'logs', element: <Placeholder title="日志查看" note="过滤、分页、CSV 导出（M5）" /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
])