import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface Props {
  sql: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** 查看查询 SQL 弹窗（结果溯源：PRD 5.2「点击表格/图表可查看对应查询语句」） */
export function SqlQueryDialog({ sql, open, onOpenChange }: Props) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sql)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* 剪贴板不可用则忽略 */
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>查询 SQL</DialogTitle>
        </DialogHeader>
        <pre className="max-h-72 overflow-auto rounded-md bg-muted/60 p-3 text-[12px] leading-relaxed">
          <code className="font-mono">{sql}</code>
        </pre>
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => void copy()} aria-label="复制 SQL">
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? '已复制' : '复制'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
