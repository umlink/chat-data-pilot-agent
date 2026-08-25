import { lazy, Suspense } from 'react'
import type {
  ChartContent,
  CodeExecution,
  ConfirmationContent,
  ErrorContent,
  InsightItem,
  ProgressContent,
  SuggestionItem,
  TableContent,
} from '@/types/message'
import type { Block } from '@/types/message'

// ChartBlock（recharts ~120KB gzip）仅在出现 chart block 时懒加载
const ChartBlock = lazy(() =>
  import('./ChartBlock').then((m) => ({ default: m.ChartBlock })),
)

function ChartSkeleton() {
  return (
    <div className="flex h-56 w-full items-end justify-center gap-2 rounded-md bg-muted/30 px-6 pb-4">
      {[0.4, 0.65, 0.5, 0.8, 0.95, 0.75, 0.6, 0.5].map((h, i) => (
        <div
          key={i}
          className="w-8 animate-pulse rounded-t bg-muted"
          style={{ height: `${h * 100}%` }}
        />
      ))}
    </div>
  )
}

/**
 * Block 渲染（docs/UI设计规范.md 4 与 docs/Block与协议规范.md 第 2 章）。
 * attachment / confirmation 交互动作在 M2 / M4 逐步替换为专业组件。
 */
export function BlockViewer({ block }: { block: Block }) {
  const c = block.content

  switch (block.type) {
    case 'text':
      return (
        <div className="whitespace-pre-wrap break-words text-[13px] leading-6 text-foreground">
          {String(c.text ?? '')}
        </div>
      )

    case 'code': {
      const exec = c.execution as CodeExecution | undefined
      return (
        <div className="overflow-hidden rounded-lg border border-code-border bg-code-bg">
          <div className="flex items-center gap-2 border-b border-code-border bg-code-header px-3 py-1.5">
            <span className="rounded bg-code-lang-bg px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-code-lang-fg">
              {String(c.language ?? '')}
            </span>
            {exec?.status && <span className="text-[11px] text-muted-foreground">执行：{exec.status}</span>}
          </div>
          <pre className="overflow-x-auto px-3.5 py-2.5 font-mono text-xs leading-relaxed text-code-fg">
            {String(c.code ?? '')}
          </pre>
        </div>
      )
    }

    case 'table': {
      const content = c as unknown as TableContent
      const rows = content.rows ?? []
      return (
        <div className="overflow-hidden rounded-lg border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted">
                {content.columns.map((col) => (
                  <th
                    key={col.key}
                    className="border-b px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 50).map((row, i) => (
                <tr key={i} className="border-b text-foreground last:border-b-0">
                  {content.columns.map((col) => (
                    <td key={col.key} className="px-3 py-2">
                      {String(row[col.key] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t bg-background px-3 py-1.5 text-[11px]">
            <span className="text-muted-foreground">
              {rows.length > 50 ? `已显示前 50 行，共 ${content.total} 行` : `共 ${content.total} 行`}
            </span>
            <button className="font-medium underline underline-offset-2">导出 CSV</button>
          </div>
        </div>
      )
    }

    case 'chart': {
      const content = c as unknown as ChartContent
      return (
        <div className="rounded-lg border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
          <div className="p-4">
            <div className="mb-3 text-[13px] font-semibold text-foreground">
              {content.title ?? '图表'}
            </div>
            <Suspense fallback={<ChartSkeleton />}>
              <ChartBlock content={content} />
            </Suspense>
          </div>
        </div>
      )
    }

    case 'confirmation': {
      const content = c as unknown as ConfirmationContent
      return (
        <div className="rounded-lg border border-warning bg-warning-bg p-3">
          <div className="text-sm font-medium text-foreground">{content.title}</div>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{content.description}</p>
          {content.sql && (
            <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
              {content.sql}
            </pre>
          )}
        </div>
      )
    }

    case 'insights': {
      const items = (c.items as InsightItem[]) ?? []
      return (
        <ul className="space-y-1 text-[13px] leading-6 text-foreground">
          {items.map((it, i) => (
            <li key={i}>
              <b>{it.title}</b>
              {it.detail ? ` ${it.detail}` : ''}
            </li>
          ))}
        </ul>
      )
    }

    case 'suggestions': {
      const items = (c.items as SuggestionItem[]) ?? []
      return (
        <div className="flex flex-wrap gap-2">
          {items.map((it, i) => (
            <button
              key={i}
              className="rounded-full border bg-background px-3 py-1 text-xs text-foreground hover:bg-accent"
            >
              {it.text}
            </button>
          ))}
        </div>
      )
    }

    case 'progress': {
      const content = c as unknown as ProgressContent
      return (
        <div>
          <div className="mb-1 flex justify-between text-xs text-muted-foreground">
            <span>{content.current_step ?? '处理中…'}</span>
            <span>{content.percent}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${content.percent}%` }}
            />
          </div>
        </div>
      )
    }

    case 'error': {
      const content = c as unknown as ErrorContent
      return (
        <div className="rounded-lg border border-error bg-error-bg p-3 text-[13px] leading-6 text-error">
          {content.message}
        </div>
      )
    }

    case 'attachment':
      return (
        <div className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-[11px] text-foreground">
          📎 {String(c.file_name ?? '')}（{String(c.status ?? '')}）
        </div>
      )

    default:
      return null
  }
}