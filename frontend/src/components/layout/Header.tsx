import { useNavigate } from 'react-router-dom'
import { Download, LogOut, Settings } from 'lucide-react'
import { useConfigStore } from '@/store/configStore'
import { useChatStore } from '@/store/chatStore'

interface Props {
  onLogout: () => void
}

/** 中栏 Topbar（docs/UI设计规范.md 布局 2 / 3.1） */
export function Header({ onLogout }: Props) {
  const navigate = useNavigate()
  const sessions = useChatStore((s) => s.sessions)
  const sessionId = useChatStore((s) => s.sessionId)
  const current = sessions.find((s) => s.id === sessionId)
  const providerCfg = useConfigStore((s) => s.llm['llm.provider']) as
    | { model?: string }
    | undefined
  const model = providerCfg?.model ?? '默认模型'

  return (
    <header className="flex h-[52px] shrink-0 items-center gap-3 border-b bg-background px-6">
      <span className="truncate text-sm font-semibold text-foreground">
        {current?.title ?? '未选择会话'}
      </span>
      <span className="badge badge-secondary">{model}</span>
      <div className="ml-auto flex items-center gap-1">
        <button className="btn btn-ghost btn-sm" aria-label="导出">
          <Download size={14} /> 导出
        </button>
        <button
          className="btn btn-ghost btn-icon"
          aria-label="设置"
          onClick={() => navigate('/config')}
        >
          <Settings size={16} />
        </button>
        <button className="btn btn-ghost btn-icon" onClick={onLogout} aria-label="退出登录">
          <LogOut size={16} />
        </button>
      </div>
    </header>
  )
}