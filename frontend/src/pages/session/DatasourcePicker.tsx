import { useEffect, useRef } from 'react'
import { Check, ChevronDown, Database } from 'lucide-react'
import { useChatStore } from '@/store/chatStore'
import { useDataSourceStore } from '@/store/dataSourceStore'

interface Props {
  sessionId: string
  disabled: boolean
  /** 受控展开状态（Composer 持有：数据类提示可触发打开） */
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * 上下文数据源选择器（docs/UI设计规范.md 3.12 输入区扩展）。
 * - 会话级记忆：选择存 chatStore.datasourceBySession[sessionId]，切换会话互不影响；
 * - '' = 不指定，请求体不带 datasource_id，走后端主数据源回退（契约 4.4）。
 */
export function DatasourcePicker({ sessionId, disabled, open, onOpenChange }: Props) {
  const dsList = useDataSourceStore((s) => s.list)
  const selectedId = useChatStore((s) => s.datasourceBySession[sessionId] ?? '')
  const setSelected = useChatStore((s) => s.setSessionDatasource)
  const boxRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭（a11y：mousedown 捕获，兼容按钮自身冒泡）
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onOpenChange(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, onOpenChange])

  // 无数据源时不渲染（数据源页未配置任何库）
  if (dsList.length === 0) return null

  const selected = dsList.find((d) => d.id === selectedId) ?? null

  const pick = (id: string) => {
    setSelected(sessionId, id)
    onOpenChange(false)
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => onOpenChange(!open)}
        disabled={disabled}
        aria-label={selected ? `上下文数据源：${selected.name}` : '选择上下文数据源'}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected ? `数据源：${selected.name}（点击切换）` : '选择数据源（默认自动）'}
        className="inline-flex max-w-[140px] items-center gap-1 rounded-lg px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Database size={15} className="shrink-0" />
        {selected ? (
          <span className="truncate text-[11px] font-medium text-foreground">{selected.name}</span>
        ) : (
          <span className="text-[11px]">数据源</span>
        )}
        <ChevronDown size={12} className="shrink-0" />
      </button>

      {open ? (
        <ul
          role="listbox"
          aria-label="上下文数据源"
          className="absolute bottom-full left-0 z-20 mb-1 max-h-64 w-56 overflow-y-auto rounded-xl border bg-background p-1 shadow-lg"
        >
          <li role="option" aria-selected={!selectedId}>
            <button
              onClick={() => pick('')}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-accent"
            >
              <span className="flex-1 truncate">不指定（自动）</span>
              {!selectedId ? <Check size={13} className="shrink-0 text-primary" /> : null}
            </button>
          </li>
          {dsList.map((d) => (
            <li key={d.id} role="option" aria-selected={d.id === selectedId}>
              <button
                onClick={() => pick(d.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-accent"
              >
                <span className="flex-1 truncate">{d.name}</span>
                <span className="shrink-0 rounded bg-secondary px-1 py-0.5 text-[10px] text-muted-foreground">
                  {d.type}
                </span>
                {d.id === selectedId ? <Check size={13} className="shrink-0 text-primary" /> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
