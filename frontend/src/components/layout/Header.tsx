import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, Download, FileText, History, LogOut, Moon, Printer, Settings, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { downloadFile } from '@/lib/api'
import { ensureNotifyPermission, notifyPermission, notifySupported } from '@/lib/notify'
import { getTheme, setTheme, type Theme } from '@/lib/theme'
import { useLlmProviderStore } from '@/store/llmProviderStore'
import { useChatStore } from '@/store/chatStore'
import { collectSql } from '@/lib/sqlRecords'
import { SqlHistoryDialog } from '@/components/chat/SqlHistoryDialog'

interface Props {
  onLogout: () => void
}

/** 中栏 Topbar（docs/UI设计规范.md 布局 2 / 3.1） */
export function Header({ onLogout }: Props) {
  const navigate = useNavigate()
  const sessions = useChatStore((s) => s.sessions)
  const sessionId = useChatStore((s) => s.sessionId)
  const rawMessages = useChatStore((s) => (sessionId ? s.messagesBySession[sessionId] : undefined))
  const messages = useMemo(() => rawMessages ?? [], [rawMessages])
  const current = sessions.find((s) => s.id === sessionId)
  const providers = useLlmProviderStore((s) => s.providers)
  const load = useLlmProviderStore((s) => s.load)
  const def = providers.find((p) => p.is_default)
  const modelLabel = def ? `${def.name} · ${def.default_model || '默认模型'}` : '默认模型'
  const canExport = messages.length > 0
  const sqlCount = useMemo(() => collectSql(messages).length, [messages])
  const [sqlHistOpen, setSqlHistOpen] = useState(false)
  // 明暗主题（PRD 5.6）
  const [theme, setThemeState] = useState<Theme>(getTheme)
  // 浏览器通知授权状态（PRD 5.6）
  const [notifyOn, setNotifyOn] = useState(() => notifySupported() && notifyPermission() === 'granted')

  useEffect(() => {
    void load()
  }, [load])

  const toggleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    setThemeState(next)
  }

  const toggleNotify = async () => {
    const p = await ensureNotifyPermission()
    setNotifyOn(p === 'granted')
  }

  const exportConversation = async () => {
    if (!sessionId || !canExport) return
    const title = current?.title ?? '对话记录'
    await downloadFile('/export', `${title}.md`, {
      body: { type: 'conversation', format: 'markdown', data: { title, messages } },
    })
  }

  const exportConversationPdf = () => {
    if (!canExport) return
    // PRD：PDF 通过浏览器打印当前对话内容（打印对话框可另存为 PDF）
    window.print()
  }

  return (
    <header className="flex h-[52px] shrink-0 items-center gap-3 border-b bg-background px-6 print:hidden">
      <span className="truncate text-sm font-semibold text-foreground">
        {current?.title ?? '未选择会话'}
      </span>
      <span className="badge badge-secondary">{modelLabel}</span>
      <div className="ml-auto flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={!canExport}
            className="btn btn-ghost btn-sm disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="导出"
          >
            <Download size={14} /> 导出
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void exportConversation()}>
              <FileText size={14} /> 导出对话（Markdown）
            </DropdownMenuItem>
            <DropdownMenuItem onClick={exportConversationPdf}>
              <Printer size={14} /> 导出对话（PDF）
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void toggleTheme()}
          aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void toggleNotify()}
          aria-label={notifyOn ? '任务通知已开启' : '开启任务通知'}
          title={notifyOn ? '任务通知已开启' : '开启任务通知（长任务完成/失败时提醒）'}
        >
          <Bell size={16} className={notifyOn ? 'text-primary' : ''} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled={sqlCount === 0}
          onClick={() => setSqlHistOpen(true)}
          aria-label="SQL 历史"
          title={`SQL 历史（${sqlCount}）`}
        >
          <History size={16} />
        </Button>
        <Button variant="ghost" size="icon" aria-label="设置" onClick={() => navigate('/config')}>
          <Settings size={16} />
        </Button>
        <Button variant="ghost" size="icon" onClick={onLogout} aria-label="退出登录">
          <LogOut size={16} />
        </Button>
      </div>
      <SqlHistoryDialog messages={messages} open={sqlHistOpen} onOpenChange={setSqlHistOpen} />
    </header>
  )
}