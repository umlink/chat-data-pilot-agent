import { useState, type ReactNode } from 'react'
import { Code, Database, Table2 } from 'lucide-react'
import type { SourceItem } from '@/types/message'
import { SqlQueryDialog } from './SqlQueryDialog'

function chipIcon(label: string): ReactNode {
  if (label.startsWith('数据源：')) return <Database size={12} />
  if (label.startsWith('查询')) return <Code size={12} />
  return <Table2 size={12} />
}

/**
 * 数据来源 / 证据链（契约 2.11 sources）：展示本回合结论引用的数据源、表与查询。
 * 数据源/表名 chip 只读；「查询 N」chip 可点击，弹 SqlQueryDialog 查看完整 SQL。
 */
export function SourcesBlock({ content }: { content: { items: SourceItem[] } }) {
  const [sql, setSql] = useState<string | null>(null)
  const items = content.items ?? []
  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-medium text-muted-foreground">数据来源</span>
      {items.map((it) => {
        const inner = (
          <span className="inline-flex items-center gap-1">
            {chipIcon(it.label)}
            {it.label}
          </span>
        )
        return it.sql ? (
          <button
            key={it.label}
            onClick={() => setSql(it.sql ?? '')}
            aria-label={`查看查询 SQL：${it.label}`}
            title="点击查看查询语句"
            className="inline-flex items-center rounded-full border bg-background px-2.5 py-0.5 text-[11px] text-foreground transition-colors hover:bg-accent"
          >
            {inner}
          </button>
        ) : (
          <span
            key={it.label}
            className="inline-flex items-center rounded-full border bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground"
          >
            {inner}
          </span>
        )
      })}
      <SqlQueryDialog
        sql={sql ?? ''}
        open={sql !== null}
        onOpenChange={(open) => {
          if (!open) setSql(null)
        }}
      />
    </div>
  )
}
