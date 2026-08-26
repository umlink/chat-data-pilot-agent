import { useMemo, useState } from 'react'
import { downloadFile } from '@/lib/api'
import type { TableContent, TableColumn } from '@/types/message'

interface Props {
  content: TableContent
}

const MAX_VISIBLE_ROWS = 50

/** 单列智能宽度：数字列窄、文本列按内容估算（上限 360px，多列时收缩） */
function colWidth(col: TableColumn, values: string[]): number {
  if (col.dtype === 'number' || col.dtype === 'boolean') return 110
  const labelLen = (col.label ?? col.key ?? '').length
  const valueLens = values.map((v) => (typeof v === 'string' ? v.length : 0))
  const max = Math.max(labelLen, ...valueLens, 4)
  // 12px 中文字 / 7px 英文（保守估算）
  return Math.min(420, Math.max(96, max * 9 + 48))
}

/**
 * 表格 Block（docs/UI设计规范.md 3.6）。
 * - 列多时整体横向滚动（外层 overflow-x-auto，不是 overflow-hidden 裁掉）；
 * - 粘性表头，单元格长文本省略号（title 悬浮看全文）；
 * - 数字列右对齐等宽；导出 CSV 走 /api/export。
 */
export function TableBlock({ content }: Props) {
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const rows = content.rows ?? []
  const columns = content.columns ?? []

  const widths = useMemo(
    () =>
      columns.map((c) => {
        const vals = rows
          .slice(0, 50)
          .map((r) => (r && c.key in r ? String(r[c.key] ?? '') : ''))
        return colWidth(c, vals)
      }),
    [columns, rows],
  )

  const exportCsv = async () => {
    if (exporting) return
    setExporting(true)
    setExportError('')
    try {
      const base = String(content.query || 'table')
        .slice(0, 40)
        .replace(/[^\w一-龥-]+/g, '_')
      await downloadFile('/export', `${base}.csv`, {
        body: {
          type: 'table',
          format: 'csv',
          data: { columns: content.columns, rows: content.rows },
        },
      })
    } catch (e) {
      setExportError(e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  const truncated = rows.length > MAX_VISIBLE_ROWS
  const visibleRows = truncated ? rows.slice(0, MAX_VISIBLE_ROWS) : rows

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      {/* 横向滚动容器：列多时滚动，不裁切 */}
      <div className="max-w-full overflow-x-auto">
        <table
          className="border-collapse text-xs"
          style={{ width: 'max-content', minWidth: '100%' }}
        >
          <thead>
            <tr className="bg-muted">
              {columns.map((col, i) => {
                const numeric = col.dtype === 'number'
                return (
                  <th
                    key={col.key}
                    style={{ width: widths[i], maxWidth: widths[i] }}
                    className={`border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground ${
                      numeric ? 'text-right' : 'text-left'
                    }`}
                  >
                    {col.label}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, i) => (
              <tr key={i} className="border-b text-foreground last:border-b-0 hover:bg-muted/40">
                {columns.map((col) => {
                  const raw = row[col.key]
                  const text = raw == null ? '' : String(raw)
                  const numeric = col.dtype === 'number'
                  return (
                    <td
                      key={col.key}
                      className={`max-w-0 truncate px-3 py-2 ${
                        numeric ? 'text-right font-mono tabular-nums' : 'text-left'
                      }`}
                      title={text}
                    >
                      {text}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between border-t bg-background px-3 py-1.5 text-[11px]">
        <span className="text-muted-foreground">
          {truncated ? `已显示前 ${MAX_VISIBLE_ROWS} 行，共 ${content.total} 行` : `共 ${content.total} 行`}
        </span>
        <button
          onClick={() => void exportCsv()}
          disabled={exporting}
          aria-label="导出 CSV"
          className="font-medium underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {exporting ? '导出中…' : '导出 CSV'}
        </button>
      </div>
      {exportError ? (
        <div className="border-t px-3 py-1.5 text-[11px] text-error">{exportError}</div>
      ) : null}
    </div>
  )
}
