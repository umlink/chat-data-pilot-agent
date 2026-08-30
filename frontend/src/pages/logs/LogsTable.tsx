import type { LogEntry } from '@/types/config'

/** 级别 → 语义徽标类（docs/UI设计规范.md 3.2，只用语义 token） */
const LEVEL_CLASS: Record<string, string> = {
  DEBUG: 'badge-secondary',
  INFO: 'badge-primary',
  WARNING: 'bg-warning-bg text-warning',
  ERROR: 'bg-error-bg text-error',
  CRITICAL: 'bg-error text-error-bg',
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 日志表格：时间 / 级别 / 分类 / 消息（2 行截断）/ 上下文（截断 + title 悬浮）。 */
export function LogsTable({ items }: { items: LogEntry[] }) {
  if (items.length === 0) {
    return <div className="rounded-lg border py-16 text-center text-[13px] text-muted-foreground">暂无日志</div>
  }
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-xs">
          <thead>
            <tr className="bg-muted text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">时间</th>
              <th className="px-4 py-2.5 font-medium">级别</th>
              <th className="px-4 py-2.5 font-medium">分类</th>
              <th className="px-4 py-2.5 font-medium">消息</th>
              <th className="px-4 py-2.5 font-medium">上下文</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const context = item.context ?? {}
              const ctxText = Object.keys(context).length > 0 ? JSON.stringify(context) : '-'
              return (
                <tr key={item.id} className="border-t align-top hover:bg-muted/50">
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
                    {formatTime(item.timestamp)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`badge ${LEVEL_CLASS[item.level] ?? 'badge-secondary'}`}>{item.level}</span>
                  </td>
                  <td className="px-4 py-2.5 text-foreground">{item.category}</td>
                  <td className="max-w-[380px] px-4 py-2.5" title={item.message}>
                    <span className="line-clamp-2">{item.message}</span>
                  </td>
                  <td className="max-w-[280px] px-4 py-2.5" title={ctxText}>
                    <code className="block truncate font-mono text-[11px] text-muted-foreground">{ctxText}</code>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
