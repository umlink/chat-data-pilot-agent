import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { Activity, Database, Plus, Search, Settings2, Trash2 } from 'lucide-react'
import { api, getUsername } from '@/lib/api'
import { cancelRunningStream } from '@/hooks/useChat'
import { useChatStore } from '@/store/chatStore'
import type { Message, SessionInfo } from '@/types/message'

const NAV = [
  { to: '/datasources', label: '数据源', icon: Database },
  { to: '/config', label: '管理后台', icon: Settings2, badge: true },
]

/** 左侧 Sidebar 260px（docs/UI设计规范.md 3.13 侧边栏） */
export function Sidebar() {
  const sessions = useChatStore((s) => s.sessions)
  const sessionId = useChatStore((s) => s.sessionId)
  const setSessions = useChatStore((s) => s.setSessions)
  const setSessionId = useChatStore((s) => s.setSessionId)
  const setMessages = useChatStore((s) => s.setMessages)
  const [keyword, setKeyword] = useState('')
  const username = getUsername() ?? '用户'
  const filtered = sessions.filter((s) =>
    s.title.toLowerCase().includes(keyword.toLowerCase()),
  )

  useEffect(() => {
    let alive = true
    void api
      .get<SessionInfo[]>('/sessions')
      .then((list) => {
        if (alive) setSessions(list)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [setSessions])

  const createSession = async () => {
    cancelRunningStream() // 切换会话前取消进行中的 SSE（CLAUDE.md 5.4）
    try {
      const s = await api.post<SessionInfo>('/sessions', { title: '新对话' })
      setSessions([s, ...sessions])
      setSessionId(s.id)
      setMessages([])
    } catch {
      /* 后端未实现时忽略 */
    }
  }

  const select = async (id: string) => {
    cancelRunningStream() // 切换会话前取消进行中的 SSE（CLAUDE.md 5.4）
    setSessionId(id)
    try {
      const msgs = await api.get<Message[]>(`/sessions/${id}/messages`)
      setMessages(msgs)
    } catch {
      setMessages([])
    }
  }

  const remove = async (id: string) => {
    cancelRunningStream()
    try {
      await api.post('/sessions/delete', { id })
      setSessions(sessions.filter((x) => x.id !== id))
      if (sessionId === id) {
        setSessionId(null)
        setMessages([])
      }
    } catch {
      /* ignore */
    }
  }

  return (
    <aside className="flex h-full w-[260px] shrink-0 flex-col border-r bg-sidebar">
      {/* 品牌栏 */}
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b px-4">
        <div className="flex size-7 items-center justify-center rounded-[7px] bg-primary text-primary-foreground">
          <Activity size={16} />
        </div>
        <span className="text-[15px] font-semibold text-foreground">DataPilot</span>
        <span className="ml-auto text-[11px] text-muted-foreground">v1.0</span>
      </div>

      {/* 新建对话 */}
      <div className="shrink-0 p-3">
        <button
          onClick={createSession}
          className="btn btn-primary h-[38px] w-full rounded-lg text-[13px]"
        >
          <Plus size={15} /> 新建对话
        </button>
      </div>

      {/* 搜索 */}
      <div className="relative shrink-0 px-3 pb-2">
        <Search className="absolute left-[22px] top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索对话…"
          className="h-[34px] w-full rounded-md border border-input bg-background pl-9 pr-3 text-[13px] outline-none focus:border-ring"
        />
      </div>

      {/* 会话列表 */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {filtered.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">暂无会话</div>
        )}
        {filtered.map((s) => {
          const active = s.id === sessionId
          return (
            <div
              key={s.id}
              onClick={() => select(s.id)}
              className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] transition-colors ${
                active
                  ? 'bg-sidebar-active font-medium text-sidebar-active-foreground'
                  : 'text-foreground hover:bg-sidebar-accent'
              }`}
            >
              <span className="flex-1 truncate">{s.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  remove(s.id)
                }}
                aria-label="删除会话"
                className="flex size-[22px] items-center justify-center rounded-[4px] opacity-0 transition-opacity hover:bg-black/5 group-hover:opacity-60 hover:opacity-100!"
              >
                <Trash2 size={13} />
              </button>
            </div>
          )
        })}
      </nav>

      {/* 底部导航 + 用户 */}
      <div className="shrink-0 border-t p-2">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] ${
                isActive ? 'bg-accent text-foreground' : 'text-foreground hover:bg-accent'
              }`
            }
          >
            <item.icon size={16} className="shrink-0" />
            <span className="flex-1">{item.label}</span>
            {item.badge && (
              <span className="rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                Admin
              </span>
            )}
          </NavLink>
        ))}
        <div className="mt-1 flex items-center gap-2.5 rounded-lg px-2.5 py-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-[13px] font-semibold text-primary-foreground">
            {username[0]?.toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-foreground">{username}</div>
            <div className="text-[11px] text-muted-foreground">Analyst</div>
          </div>
        </div>
      </div>
    </aside>
  )
}