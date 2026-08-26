import { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Download, FileText, LogOut, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { downloadFile } from '@/lib/api'
import { useLlmProviderStore } from '@/store/llmProviderStore'
import { useChatStore } from '@/store/chatStore'

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

  useEffect(() => {
    void load()
  }, [load])

  const exportConversation = async () => {
    if (!sessionId || !canExport) return
    const title = current?.title ?? '对话记录'
    await downloadFile('/export', `${title}.md`, {
      body: { type: 'conversation', format: 'markdown', data: { title, messages } },
    })
  }

  return (
    <header className="flex h-[52px] shrink-0 items-center gap-3 border-b bg-background px-6">
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
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="icon" aria-label="设置" onClick={() => navigate('/config')}>
          <Settings size={16} />
        </Button>
        <Button variant="ghost" size="icon" onClick={onLogout} aria-label="退出登录">
          <LogOut size={16} />
        </Button>
      </div>
    </header>
  )
}