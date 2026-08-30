import { useState } from 'react'
import { api } from '@/lib/api'
import { useChatStore } from '@/store/chatStore'
import type { Block, ConfirmationContent, Message } from '@/types/message'

interface Props {
  block: Block
  content: ConfirmationContent
}

/** POST /api/chat/execute 响应 data（见 backend/app/api/chat.py chat_execute） */
interface ExecuteResponse {
  message: Message
  result_block_id?: string
}

/**
 * 确认卡片决策闭环（docs/Block与协议规范.md 2.5 / 4）。
 * - 未决：SQL 可编辑 textarea + 确认执行/拒绝按钮；决策调 POST /api/chat/execute
 * - 已决：仅展示结果徽标（结果 table block 由后端追加，经 replaceMessage 整体替换消息出现）
 */
export function ConfirmationBlock({ block, content }: Props) {
  const [sqlDraft, setSqlDraft] = useState(content.sql ?? '')
  const [decision, setDecision] = useState<'confirm' | 'cancel' | null>(null)
  const [decisionError, setDecisionError] = useState('')

  if (block.status === 'completed' || block.status === 'rejected') {
    const confirmed = block.status === 'completed'
    return (
      <div className="rounded-lg border border-warning bg-warning-bg p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-medium text-foreground">{content.title}</div>
          {confirmed ? (
            <span className="badge badge-success">已确认执行</span>
          ) : (
            <span className="badge badge-secondary">已拒绝</span>
          )}
        </div>
        {content.description ? (
          <p className="mt-0.5 text-[13px] text-muted-foreground">{content.description}</p>
        ) : null}
        {content.datasource_name ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            目标数据源：<span className="font-medium text-foreground">{content.datasource_name}</span>
          </p>
        ) : null}
        {content.sql ? (
          <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs text-foreground">
            {content.sql}
          </pre>
        ) : null}
      </div>
    )
  }

  const decide = async (value: 'confirm' | 'cancel') => {
    if (decision !== null) return
    setDecision(value)
    setDecisionError('')
    try {
      const data = await api.post<ExecuteResponse>('/chat/execute', {
        block_id: block.id,
        decision: value,
        ...(value === 'confirm' && sqlDraft.trim() ? { sql: sqlDraft } : {}),
      })
      // 后端返回该消息的完整最新序列化（含卡片回填与结果 block），整体替换对应消息
      useChatStore.getState().replaceMessage(data.message.session_id, data.message)
    } catch (e) {
      setDecisionError(e instanceof Error ? e.message : '操作失败')
      setDecision(null)
    }
  }

  const confirmClass =
    content.risk_level === 'high'
      ? 'btn btn-sm border border-error bg-error-bg text-error hover:bg-error/10'
      : 'btn btn-sm btn-primary'

  return (
    <div className="rounded-lg border border-warning bg-warning-bg p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-foreground">{content.title}</div>
        {content.risk_level === 'high' && (
          <span className="badge badge-outline border-warning text-warning">高风险</span>
        )}
      </div>
      {content.description ? (
        <p className="mt-0.5 text-[13px] text-muted-foreground">{content.description}</p>
      ) : null}
      {content.datasource_name ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          目标数据源：<span className="font-medium text-foreground">{content.datasource_name}</span>
        </p>
      ) : null}
      {content.sql !== undefined ? (
        <textarea
          value={sqlDraft}
          onChange={(e) => setSqlDraft(e.target.value)}
          disabled={decision !== null}
          rows={Math.max(3, sqlDraft.split('\n').length)}
          spellCheck={false}
          aria-label="可编辑 SQL"
          className="mt-2 w-full resize-y rounded-md border border-input bg-background p-2 font-mono text-xs leading-relaxed text-foreground outline-none focus:border-ring disabled:opacity-60"
        />
      ) : null}
      <div className="mt-2.5 flex items-center gap-2">
        <button
          onClick={() => void decide('confirm')}
          disabled={decision !== null}
          aria-label="确认执行"
          className={confirmClass}
        >
          {decision === 'confirm' ? '执行中…' : '确认执行'}
        </button>
        <button
          onClick={() => void decide('cancel')}
          disabled={decision !== null}
          aria-label="拒绝并取消"
          className="btn btn-sm btn-ghost border border-input"
        >
          {decision === 'cancel' ? '处理中…' : '拒绝'}
        </button>
        {decisionError ? <span className="text-[11px] text-error">{decisionError}</span> : null}
      </div>
    </div>
  )
}
