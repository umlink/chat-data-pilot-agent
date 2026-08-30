import { lazy, Suspense, useState } from 'react'
import { Check, Copy, Loader2, Pencil, Play, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useChatStore } from '@/store/chatStore'
import type { Block, CodeContent, Message } from '@/types/message'

interface Props {
  block: Block
  content: CodeContent
}

/** POST /api/chat/execute 响应 data（见 backend/app/api/chat.py chat_execute） */
interface ExecuteResponse {
  message: Message
  result_block_id?: string
}

// Monaco（~1MB+ chunk）按需懒加载，仅出现 code block 时下载（技术方案「按需加载 Monaco」）
const CodeEditor = lazy(() =>
  import('./CodeEditor').then((m) => ({ default: m.CodeEditor })),
)

/** 编辑器高度：按行数自适应（行高 ~18px + 上下 padding 16px），限高避免过长 */
function editorHeight(code: string): number {
  const lines = code.split('\n').length
  return Math.min(Math.max(lines * 18 + 16, 96), 320)
}

function EditorFallback({ height }: { height: number }) {
  return (
    <div
      className="flex items-center justify-center text-muted-foreground"
      style={{ height }}
      role="status"
      aria-label="代码编辑器加载中"
    >
      <Loader2 size={14} className="animate-spin" />
    </div>
  )
}

/**
 * 代码块（docs/Block与协议规范.md 2.2 / 6.1 / PRD 3.1.3）：
 * - Monaco 渲染：只读回显带 SQL 语法高亮，[编辑] 切换可编辑态；
 * - SQL 块提供 [编辑][执行]，编辑后执行走 /api/chat/execute；
 * - 执行结果由后端回填 code.content.execution，并在消息尾部追加 table block（parent_block_id 关联）。
 */
export function CodeBlock({ block, content }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(content.code ?? '')
  const [executing, setExecuting] = useState(false)
  const [execError, setExecError] = useState('')
  const [copied, setCopied] = useState(false)

  const language = content.language ?? 'sql'
  const exec = content.execution
  const execFailed = exec?.status === 'failed'

  const enterEdit = () => {
    setDraft(content.code ?? '')
    setExecError('')
    setEditing(true)
  }

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(content.code ?? '')
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* 剪贴板不可用时静默 */
    }
  }

  const execute = async (sql: string) => {
    if (executing) return
    const st = useChatStore.getState()
    if (!st.sessionId) return
    setExecuting(true)
    setExecError('')
    try {
      const data = await api.post<ExecuteResponse>('/chat/execute', {
        block_id: block.id,
        decision: 'confirm',
        sql,
        ...(st.datasourceBySession[st.sessionId]
          ? { datasource_id: st.datasourceBySession[st.sessionId] }
          : {}),
      })
      // 后端返回该消息完整序列化（含 execution 回填 + 结果 table block），整体替换
      useChatStore.getState().replaceMessage(data.message.session_id, data.message)
    } catch (e) {
      // 网络/4xx 兜底：本地提示；业务失败（SQL 错误等）由后端回填 execution 并随 message 返回
      setExecError(e instanceof Error ? e.message : '执行失败')
    } finally {
      setExecuting(false)
      setEditing(false)
    }
  }

  const shownCode = editing ? draft : content.code ?? ''
  const height = editorHeight(shownCode)

  return (
    <div className="overflow-hidden rounded-lg border border-code-border bg-code-bg">
      {/* 头部：语言徽标 + 执行状态 + 操作按钮 */}
      <div className="flex items-center gap-2 border-b border-code-border bg-code-header px-3 py-1.5">
        <span className="rounded bg-code-lang-bg px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-code-lang-fg">
          {language}
        </span>
        {exec?.status === 'success' ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-success">
            <Check size={11} /> 执行成功{exec.duration_ms != null ? ` · ${exec.duration_ms}ms` : ''}
          </span>
        ) : null}
        {execFailed ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-error">
            执行失败{exec.duration_ms != null ? ` · ${exec.duration_ms}ms` : ''}
          </span>
        ) : null}
        {executing ? <span className="text-[11px] text-muted-foreground">执行中…</span> : null}

        <div className="ml-auto flex items-center gap-0.5">
          <button
            onClick={() => void copyCode()}
            aria-label="复制代码"
            title="复制"
            className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-white/10 hover:text-foreground"
          >
            {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          </button>
          {content.editable && language === 'sql' && !editing ? (
            <button
              onClick={enterEdit}
              aria-label="编辑 SQL"
              title="编辑"
              className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-white/10 hover:text-foreground"
            >
              <Pencil size={12} />
            </button>
          ) : null}
          {content.editable && language === 'sql' ? (
            <button
              onClick={() => void execute(shownCode)}
              disabled={executing || (editing && !shownCode.trim())}
              aria-label="执行 SQL"
              title="执行"
              className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-white/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Play size={12} />
            </button>
          ) : null}
        </div>
      </div>

      {/* Monaco：编辑态可编辑 + 操作条；只读态高亮回显 */}
      {editing ? (
        <div>
          <Suspense fallback={<EditorFallback height={height} />}>
            <CodeEditor
              value={draft}
              readOnly={false}
              height={height}
              onChange={(v) => setDraft(v)}
            />
          </Suspense>
          <div className="flex items-center gap-2 border-t border-code-border bg-code-header px-3 py-2">
            <button
              onClick={() => void execute(draft)}
              disabled={executing || !draft.trim()}
              className="btn btn-sm btn-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Play size={12} /> {executing ? '执行中…' : '执行'}
            </button>
            <button
              onClick={() => {
                setEditing(false)
                setExecError('')
              }}
              disabled={executing}
              className="btn btn-sm btn-ghost border border-input"
            >
              <X size={12} /> 取消
            </button>
            {execError ? <span className="text-[11px] text-error">{execError}</span> : null}
          </div>
        </div>
      ) : (
        <>
          <Suspense fallback={<EditorFallback height={height} />}>
            <CodeEditor value={content.code ?? ''} readOnly height={height} />
          </Suspense>
          {execError || (execFailed && exec?.error) ? (
            <div className="border-t border-error/30 bg-error-bg px-3.5 py-2 text-[11px] text-error">
              {execError || exec?.error}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
