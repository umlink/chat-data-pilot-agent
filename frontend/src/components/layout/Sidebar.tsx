import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Activity, AlarmClock, Bell, CalendarClock, Database, FileText, LineChart, MessageSquare, Pencil, Plus, ScrollText, Search, Settings2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api, getUsername } from '@/lib/api'
import { cancelStream } from '@/hooks/useChat'
import { useChatStore } from '@/store/chatStore'
import type { SessionInfo } from '@/types/message'

const NAV = [
  { to: '/datasources', label: '数据源', icon: Database },
  { to: '/board', label: '我的看板', icon: LineChart },
  { to: '/reports', label: '定时报告', icon: CalendarClock },
  { to: '/automations', label: '定时任务', icon: AlarmClock },
  { to: '/notifications', label: '通知渠道', icon: Bell },
  { to: '/templates', label: '模板', icon: FileText },
  { to: '/stats', label: '用量统计', icon: Activity },
  { to: '/logs', label: '日志', icon: ScrollText },
  { to: '/config', label: '管理后台', icon: Settings2, badge: true },
]

/** 左侧 Sidebar 260px（docs/UI设计规范.md 3.13 侧边栏） */
export function Sidebar() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const sessions = useChatStore((s) => s.sessions)
  const sessionId = useChatStore((s) => s.sessionId)
  const setSessions = useChatStore((s) => s.setSessions)
  const [keyword, setKeyword] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<SessionInfo | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [deleting, setDeleting] = useState(false)
  // 同步跟踪当前重命名会话：Escape 取消时输入框卸载触发 onBlur→commitRename，
  // 若仍读 state 会把「取消」误提交为「保存」，故用 ref 即时置空做兜底
  const renamingRef = useRef<string | null>(null)
  const username = getUsername() ?? '用户'
  // 对话工作台激活态：/ 与 /session/:id 均高亮「对话」
  const chatActive = pathname === '/' || pathname.startsWith('/session')
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
    try {
      const s = await api.post<SessionInfo>('/sessions', { title: '新对话' })
      setSessions((prev) => [s, ...prev])
      navigate(`/session/${s.id}`) // 会话选中状态由路由承载（/session/:id）
    } catch {
      /* 后端未实现时忽略 */
    }
  }

  const select = (id: string) => {
    // 仅导航；loading/取消 SSE 由 ChatArea 随路由变化统一处理
    navigate(`/session/${id}`)
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    setDeleteError('')
    cancelStream(deleteTarget.id) // 仅取消被删除会话的流，不影响其它会话
    try {
      await api.post('/sessions/delete', { id: deleteTarget.id })
      setSessions((prev) => prev.filter((x) => x.id !== deleteTarget.id))
      if (sessionId === deleteTarget.id) navigate('/')
      setDeleteTarget(null)
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  const startRename = (s: SessionInfo) => {
    renamingRef.current = s.id
    setRenamingId(s.id)
    setRenameValue(s.title)
  }

  const commitRename = async () => {
    const id = renamingRef.current
    if (!id) return // 已取消（Escape）或未处于重命名态：不提交
    renamingRef.current = null
    const title = renameValue.trim() || '新对话'
    setRenamingId(null)
    try {
      await api.post('/sessions/update', { id, title })
      setSessions((prev) => prev.map((x) => (x.id === id ? { ...x, title } : x)))
    } catch {
      /* 保存失败保留原标题 */
    }
  }

  return (
    <aside className="flex h-full w-[260px] shrink-0 flex-col border-r bg-sidebar print:hidden">
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
          aria-label="搜索对话"
          autoComplete="off"
          spellCheck={false}
          className="h-[34px] w-full rounded-md border border-input bg-background pl-9 pr-3 text-[13px] outline-none focus:border-ring"
        />
      </div>

      {/* 会话列表 */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {filtered.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            {keyword ? '无匹配会话' : '暂无会话，点击上方「新建对话」开始'}
          </div>
        )}
        {filtered.map((s) => {
          const active = s.id === sessionId
          const renaming = renamingId === s.id
          return (
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              onClick={() => select(s.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  select(s.id)
                }
              }}
              className={`group flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors ${
                active
                  ? 'bg-sidebar-active font-medium text-sidebar-active-foreground'
                  : 'text-foreground hover:bg-sidebar-accent'
              }`}
            >
              {renaming ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => void commitRename()}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') void commitRename()
                    if (e.key === 'Escape') {
                      renamingRef.current = null // 先置空，避免卸载 onBlur 误提交
                      setRenamingId(null)
                    }
                  }}
                  aria-label="重命名会话"
                  className="min-w-0 flex-1 rounded border border-ring bg-background px-1.5 py-0.5 text-[13px] outline-none"
                />
              ) : (
                <span className="flex-1 truncate">{s.title}</span>
              )}
              {!renaming ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    startRename(s)
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  aria-label="重命名会话"
                  className="flex size-[22px] items-center justify-center rounded-[4px] opacity-0 transition-opacity hover:bg-sidebar-accent group-hover:opacity-60 hover:opacity-100! focus-visible:opacity-100"
                >
                  <Pencil size={13} />
                </button>
              ) : null}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setDeleteError('')
                  setDeleteTarget(s)
                }}
                onKeyDown={(e) => e.stopPropagation()}
                aria-label="删除会话"
                className="flex size-[22px] items-center justify-center rounded-[4px] opacity-0 transition-opacity hover:bg-sidebar-accent group-hover:opacity-60 hover:opacity-100! focus-visible:opacity-100"
              >
                <Trash2 size={13} />
              </button>
            </div>
          )
        })}
      </nav>

      {/* 底部导航 + 用户 */}
      <div className="shrink-0 border-t p-2">
        {/* 对话工作台：/ 与 /session/:id 高亮 */}
        <NavLink
          to="/"
          end
          className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] ${
            chatActive ? 'bg-accent text-foreground' : 'text-foreground hover:bg-accent'
          }`}
        >
          <MessageSquare size={16} className="shrink-0" />
          <span className="flex-1">对话</span>
        </NavLink>
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

      <Dialog open={deleteTarget !== null} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="text-[15px] font-semibold">删除会话</DialogTitle>
          </DialogHeader>
          <p className="text-[13px] text-muted-foreground">
            确定删除会话「{deleteTarget?.title}」？删除后对话记录将无法恢复。
          </p>
          {deleteError && <p className="text-[13px] text-error" role="alert">{deleteError}</p>}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              取消
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting ? '删除中…' : '删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  )
}