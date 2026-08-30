import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, ArrowUpDown, Search, Send } from 'lucide-react'
import { downloadFile } from '@/lib/api'
import type { TableColumn, TableContent } from '@/types/message'
import { PushToChannelDialog } from './PushToChannelDialog'
import { SqlQueryDialog } from './SqlQueryDialog'

interface Props {
  content: TableContent
}

type SortDir = 'asc' | 'desc'

/** 虚拟滚动视口最大高度（PRD 11.1：10 万行虚拟滚动不卡顿） */
const MAX_BODY_HEIGHT = 440
/** 行高估算（text-xs + py-2 ≈ 32px），measureElement 实测后自动校正 */
const ESTIMATED_ROW_HEIGHT = 32
const OVERSCAN = 12

/** 单列智能宽度：数字列窄、文本列按内容估算（上限 360px，多列时收缩） */
function colWidth(col: TableColumn, values: string[]): number {
  if (col.dtype === 'number' || col.dtype === 'boolean') return 110
  const labelLen = (col.label ?? col.key ?? '').length
  const valueLens = values.map((v) => (typeof v === 'string' ? v.length : 0))
  const max = Math.max(labelLen, ...valueLens, 4)
  // 12px 中文字 / 7px 英文（保守估算）
  return Math.min(420, Math.max(96, max * 9 + 48))
}

/** 单元格转可比较值：数字列优先数值比较，其余按字符串（中文 localeCompare） */
function compareValue(a: unknown, b: unknown): number {
  const na = typeof a === 'number' ? a : Number(a)
  const nb = typeof b === 'number' ? b : Number(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  return String(a ?? '').localeCompare(String(b ?? ''), 'zh-Hans-CN')
}

/**
 * 表格 Block（docs/UI设计规范.md 3.6 / PRD 3.1.2 & 11.1）：
 * - 列头点击排序（asc/desc 循环）、顶部关键字筛选（全列匹配）；
 * - @tanstack/react-virtual 虚拟滚动：仅渲染可视区 ±overscan 行，10 万行不卡顿；
 * - 导出 CSV / Excel / JSON（当前筛选+排序结果，走 /api/export）；
 * - 列多时整体横向滚动、粘性表头、长文本省略号（title 悬浮看全文）。
 */
export function TableBlock({ content }: Props) {
  // content.rows/columns 每次渲染若直接 `?? []` 会产生新引用，导致 useMemo 依赖漂移；
  // 用 useMemo 稳定引用（见 ChatArea 相同约定）
  const rows = useMemo(() => content.rows ?? [], [content.rows])
  const columns = useMemo(() => content.columns ?? [], [content.columns])
  const [keyword, setKeyword] = useState('')
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(null)
  const [exporting, setExporting] = useState<string | null>(null)
  const [exportError, setExportError] = useState('')
  const [sqlOpen, setSqlOpen] = useState(false)
  const [pushOpen, setPushOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  // 滚动容器实测宽度：列宽需「至少占满容器」，否则 fixed 布局会把 table 的
  // min-width 拉伸量摊给表头列，而绝对定位的虚拟行 td 宽度固定 → 表头与数据列错位
  const [containerW, setContainerW] = useState(0)

  // useLayoutEffect：首次绘制前完成测量，避免首帧按未缩放列宽渲染的错位闪动
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth))
    ro.observe(el)
    setContainerW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  const widths = useMemo(() => {
    const base = columns.map((c) => {
      const vals = rows
        .slice(0, 50)
        .map((r) => (r && c.key in r ? String(r[c.key] ?? '') : ''))
      return colWidth(c, vals)
    })
    const total = base.reduce((a, b) => a + b, 0)
    const target = Math.max(total, containerW)
    if (base.length === 0 || target <= total) return base
    // 等比放大至占满容器（floor 取整的余数补给最后一列，保证总和精确等于 target）
    const scaled = base.map((w) => Math.floor((w * target) / total))
    scaled[scaled.length - 1] += target - scaled.reduce((a, b) => a + b, 0)
    return scaled
  }, [columns, rows, containerW])
  const totalWidth = useMemo(() => widths.reduce((a, b) => a + b, 0), [widths])

  // 筛选：关键字对所有列做 contains 匹配
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return rows
    return rows.filter((r) =>
      columns.some((c) => String(r[c.key] ?? '').toLowerCase().includes(kw)),
    )
  }, [rows, columns, keyword])

  // 排序：stable 排序（复制数组后 sort）
  const sorted = useMemo(() => {
    if (!sort) return filtered
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => compareValue(a[sort.key], b[sort.key]) * dir)
  }, [filtered, sort])

  const rowVirtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: OVERSCAN,
  })

  // 筛选/排序变化回到顶部，避免停留在旧数据的滚动位置
  const resetScroll = () => scrollRef.current?.scrollTo({ top: 0 })

  const toggleSort = (key: string) => {
    setSort((s) =>
      s?.key === key ? (s.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' },
    )
    resetScroll()
  }

  const exportTable = async (format: 'csv' | 'excel' | 'json') => {
    if (exporting) return
    setExporting(format)
    setExportError('')
    try {
      const base = String(content.query || 'table')
        .slice(0, 40)
        .replace(/[^\w一-龥-]+/g, '_')
      await downloadFile('/export', `${base}.${format === 'excel' ? 'xlsx' : format}`, {
        body: {
          type: 'table',
          format,
          data: { columns: content.columns, rows: sorted },
        },
      })
    } catch (e) {
      setExportError(e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(null)
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      {/* 工具条：关键字筛选 + 导出 */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-background px-3 py-2">
        <div className="relative min-w-[160px] flex-1">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value)
              resetScroll()
            }}
            placeholder="筛选当前结果…"
            aria-label="筛选当前结果"
            className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-2 text-xs outline-none focus:border-ring"
          />
        </div>
        <div className="flex items-center gap-1">
          {content.query && (
            <button
              onClick={() => setSqlOpen(true)}
              aria-label="查看查询 SQL"
              className="rounded border border-input px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              SQL
            </button>
          )}
          {(['csv', 'excel', 'json'] as const).map((fmt) => (
            <button
              key={fmt}
              onClick={() => void exportTable(fmt)}
              disabled={exporting !== null || sorted.length === 0}
              aria-label={`导出 ${fmt.toUpperCase()}`}
              className="rounded border border-input px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              {exporting === fmt ? '导出中…' : fmt.toUpperCase()}
            </button>
          ))}
          <button
            onClick={() => setPushOpen(true)}
            disabled={sorted.length === 0}
            aria-label="推送到通知渠道"
            title="推送到通知渠道"
            className="inline-flex items-center gap-1 rounded border border-input px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send size={11} />
            推送
          </button>
        </div>
      </div>

      {/* 滚动容器：横向 + 纵向，虚拟行仅渲染可视区（固定布局保证表头/行对齐） */}
      <div
        ref={scrollRef}
        className="max-w-full overflow-auto"
        style={{ maxHeight: MAX_BODY_HEIGHT }}
      >
        <table
          className="border-collapse text-xs"
          // width 已由 widths 等比放大至 ≥ 容器宽，禁止再用 min-width 触发 fixed 布局的二次分配
          style={{ tableLayout: 'fixed', width: totalWidth }}
        >
          <thead className="sticky top-0 z-10">
            <tr className="bg-muted">
              {columns.map((col, i) => {
                const numeric = col.dtype === 'number'
                const active = sort?.key === col.key
                return (
                  <th
                    key={col.key}
                    style={{ width: widths[i], maxWidth: widths[i] }}
                    className={`border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground ${
                      numeric ? 'text-right' : 'text-left'
                    }`}
                  >
                    <button
                      onClick={() => toggleSort(col.key)}
                      aria-label={`按 ${col.label} 排序`}
                      title="点击排序"
                      className={`inline-flex items-center gap-1 transition-colors hover:text-foreground ${
                        numeric ? 'flex-row-reverse' : ''
                      }`}
                    >
                      {col.label}
                      {active ? (
                        sort!.dir === 'asc' ? (
                          <ArrowUp size={11} />
                        ) : (
                          <ArrowDown size={11} />
                        )
                      ) : (
                        <ArrowUpDown size={11} className="opacity-40" />
                      )}
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody style={{ position: 'relative', height: rowVirtualizer.getTotalSize() }}>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-[12px] text-muted-foreground">
                  无匹配数据
                </td>
              </tr>
            ) : (
              rowVirtualizer.getVirtualItems().map((vi) => {
                const row = sorted[vi.index]
                return (
                  <tr
                    key={vi.key}
                    data-index={vi.index}
                    ref={rowVirtualizer.measureElement}
                    className="absolute left-0 top-0 border-b text-foreground last:border-b-0 hover:bg-muted/40"
                    style={{ transform: `translateY(${vi.start}px)`, width: '100%' }}
                  >
                    {columns.map((col, j) => {
                      const raw = row[col.key]
                      const text = raw == null ? '' : String(raw)
                      const numeric = col.dtype === 'number'
                      return (
                        <td
                          key={col.key}
                          style={{ width: widths[j] }}
                          className={`truncate px-3 py-2 ${
                            numeric ? 'text-right font-mono tabular-nums' : 'text-left'
                          }`}
                          title={text}
                        >
                          {text}
                        </td>
                      )
                    })}
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* 底栏：行数统计（虚拟滚动，无分页） */}
      <div className="flex items-center gap-2 border-t bg-background px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>
          {keyword.trim()
            ? `筛选后 ${sorted.length} 行${content.total > rows.length ? `（数据源共 ${content.total} 行，已截断）` : ''}`
            : `共 ${rows.length} 行${content.total > rows.length ? `（数据源共 ${content.total} 行，已截断）` : ''}`}
        </span>
        {sorted.length > 200 ? <span>· 上下滚动查看全部</span> : null}
      </div>

      {exportError ? (
        <div className="border-t px-3 py-1.5 text-[11px] text-error">{exportError}</div>
      ) : null}
      {content.query ? (
        <SqlQueryDialog sql={content.query} open={sqlOpen} onOpenChange={setSqlOpen} />
      ) : null}
      <PushToChannelDialog
        open={pushOpen}
        onOpenChange={setPushOpen}
        subject="表格数据"
        body={`表格结果摘要\n行数：${sorted.length}${
          content.total > rows.length ? `（数据源共 ${content.total} 行，已截断）` : ''
        }`}
      />
    </div>
  )
}
