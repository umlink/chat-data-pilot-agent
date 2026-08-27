import { useMemo, useState } from 'react'
import { BarChart3, Check, ChevronDown, ChevronRight, Copy, Database, Table2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { collectSql, type SqlRecord } from '@/lib/sqlRecords'
import type { Message } from '@/types/message'

const KIND_META: Record<SqlRecord['kind'], { label: string; icon: typeof Database; cls: string }> = {
  code: { label: 'SQL 执行', icon: Database, cls: 'bg-info/10 text-info' },
  table: { label: '表格', icon: Table2, cls: 'bg-info/10 text-info' },
  chart: { label: '图表', icon: BarChart3, cls: 'bg-chart-1/10 text-chart-1' },
}

/** 会话内 SQL 历史面板（PRD 5.2：当前会话内所有执行的 SQL 可统一查看和管理） */
export function SqlHistoryDialog({
  messages,
  open,
  onOpenChange,
}: {
  messages: Message[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const records = useMemo(() => collectSql(messages), [messages])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const copy = async (id: string, sql: string) => {
    try {
      await navigator.clipboard.writeText(sql)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 1500)
    } catch {
      /* 剪贴板不可用则忽略 */
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>SQL 历史（{records.length}）</DialogTitle>
        </DialogHeader>
        {records.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">本会话暂无 SQL 记录</p>
        ) : (
          <div className="grid max-h-96 gap-2 overflow-y-auto pr-1">
            {records.map((r) => {
              const meta = KIND_META[r.kind]
              const Icon = meta.icon
              const isOpen = expanded.has(r.id)
              return (
                <div key={r.id} className="rounded-md border bg-background">
                  <button
                    onClick={() => toggle(r.id)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left"
                  >
                    {isOpen ? (
                      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px]',
                        meta.cls,
                      )}
                    >
                      <Icon className="size-3" />
                      {meta.label}
                    </span>
                    <span className="flex-1 truncate font-mono text-[11px] text-muted-foreground">
                      {r.sql.replace(/\s+/g, ' ')}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="border-t px-3 py-2">
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/60 p-2 text-[11px] font-mono leading-relaxed text-foreground">
                        {r.sql}
                      </pre>
                      <div className="mt-2 flex justify-end">
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => void copy(r.id, r.sql)}
                          aria-label="复制 SQL"
                        >
                          {copiedId === r.id ? <Check className="size-3" /> : <Copy className="size-3" />}
                          {copiedId === r.id ? '已复制' : '复制'}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
