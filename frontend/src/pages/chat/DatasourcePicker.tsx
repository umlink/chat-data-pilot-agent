import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
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

/** 可选项：首项「不指定（自动）」，其后为数据源列表（供键盘导航统一索引） */
interface OptionItem {
  id: string
  name: string
  type?: string
}

/**
 * 上下文数据源选择器（docs/UI设计规范.md 3.12 输入区扩展）。
 * - 会话级记忆：选择存 chatStore.datasourceBySession[sessionId]，切换会话互不影响；
 * - '' = 不指定，请求体不带 datasource_id，走后端主数据源回退（契约 4.4）；
 * - 键盘交互（listbox 模式）：焦点保持在浮层，↑↓/Home/End 移动高亮（aria-activedescendant），
 *   Enter/空格选择，Escape 关闭并还焦 Trigger；Trigger 保持 Tab 可达。
 */
export function DatasourcePicker({ sessionId, disabled, open, onOpenChange }: Props) {
  const dsList = useDataSourceStore((s) => s.list)
  const selectedId = useChatStore((s) => s.datasourceBySession[sessionId] ?? '')
  const setSelected = useChatStore((s) => s.setSessionDatasource)
  const boxRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  /** 键盘高亮项索引（0 = 不指定，1+ = dsList 对应项）；-1 = 无高亮 */
  const [activeIndex, setActiveIndex] = useState(-1)

  // 点击外部关闭（a11y：mousedown 捕获，兼容按钮自身冒泡）
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onOpenChange(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, onOpenChange])

  // 打开时：键盘高亮定位到当前选中项，并把焦点移到浮层（Tab 顺序仍由 Trigger 维持）
  useEffect(() => {
    if (!open) return
    const dsNow = useDataSourceStore.getState().list
    const selNow = useChatStore.getState().datasourceBySession[sessionId] ?? ''
    const idx = dsNow.findIndex((d) => d.id === selNow)
    setActiveIndex(selNow && idx >= 0 ? idx + 1 : 0)
    const raf = requestAnimationFrame(() => listRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open, sessionId])

  // 键盘高亮项滚动进浮层可视区（方向键连续导航时保证高亮可见）
  useEffect(() => {
    if (!open || activeIndex < 0) return
    listRef.current
      ?.querySelector<HTMLElement>(`[id="ds-option-${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  // 无数据源时不渲染（数据源页未配置任何库）
  if (dsList.length === 0) return null

  const options: OptionItem[] = [
    { id: '', name: '不指定（自动）' },
    ...dsList.map((d) => ({ id: d.id, name: d.name, type: d.type })),
  ]

  const selected = dsList.find((d) => d.id === selectedId) ?? null

  const pick = (id: string) => {
    setSelected(sessionId, id)
    onOpenChange(false)
    // 选择后焦点还给 Trigger，便于连续 Tab 导航
    triggerRef.current?.focus()
  }

  /** listbox 键盘导航：方向键/Home/End 移动高亮，Enter/空格选择，Escape 关闭 */
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const count = options.length
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % count)
        break
      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + count) % count)
        break
      case 'Home':
        e.preventDefault()
        setActiveIndex(0)
        break
      case 'End':
        e.preventDefault()
        setActiveIndex(count - 1)
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (activeIndex >= 0 && activeIndex < count) pick(options[activeIndex].id)
        break
      case 'Escape':
        e.preventDefault()
        onOpenChange(false)
        triggerRef.current?.focus()
        break
      case 'Tab':
        // Tab 移出浮层时收起，后续焦点交由浏览器默认导航
        onOpenChange(false)
        break
    }
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        ref={triggerRef}
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
          ref={listRef}
          role="listbox"
          aria-label="上下文数据源"
          aria-activedescendant={activeIndex >= 0 ? `ds-option-${activeIndex}` : undefined}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="absolute bottom-full left-0 z-20 mb-1 max-h-64 w-56 overflow-y-auto rounded-xl border bg-background p-1 shadow-lg"
        >
          {options.map((o, i) => {
            const active = i === activeIndex
            const isSelected = o.id === selectedId
            return (
              <li
                key={`ds-option-${i}`}
                id={`ds-option-${i}`}
                role="option"
                aria-selected={isSelected}
                className={active ? 'rounded-lg bg-accent' : ''}
              >
                <button
                  onClick={() => pick(o.id)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-accent"
                >
                  <span className="flex-1 truncate">{o.name}</span>
                  {i > 0 ? (
                    <span className="shrink-0 rounded bg-secondary px-1 py-0.5 text-[10px] text-muted-foreground">
                      {o.type}
                    </span>
                  ) : null}
                  {isSelected ? <Check size={13} className="shrink-0 text-primary" /> : null}
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
