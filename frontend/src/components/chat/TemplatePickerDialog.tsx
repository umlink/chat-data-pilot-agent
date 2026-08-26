import { useCallback, useEffect, useState } from 'react'
import { FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useChatStore } from '@/store/chatStore'
import type { Template } from '@/types/template'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 选择模板：把 SQL 填充进输入框（可编辑后发送），可选联动设置会话数据源 */
  onPick: (t: Template) => void
}

/**
 * 「使用模板」弹窗（PRD 补充：输入框提供模板入口，一键复用分析配置）。
 * 列表取自 /api/templates，选中后由 Composer 回填 SQL 到输入框。
 */
export function TemplatePickerDialog({ open, onOpenChange, onPick }: Props) {
  const [templates, setTemplates] = useState<Template[] | null>(null)
  const setSessionDatasource = useChatStore((s) => s.setSessionDatasource)

  const load = useCallback(async () => {
    try {
      const list = await api.get<Template[]>('/templates')
      setTemplates(list)
    } catch {
      setTemplates([])
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const pick = (t: Template) => {
    // 模板带数据源时联动设置会话数据源上下文（复用分析配置）
    if (t.datasource_id) {
      const sid = useChatStore.getState().sessionId
      if (sid) setSessionDatasource(sid, t.datasource_id)
    }
    onPick(t)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onOpenChange(false)}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-semibold">使用模板</DialogTitle>
          <DialogDescription className="text-xs">
            选择模板，SQL 将填充到输入框（可编辑后发送）
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
          {templates === null ? (
            [0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)
          ) : templates.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-muted-foreground">
              暂无模板，可先在「模板」页创建
            </p>
          ) : (
            templates.map((t) => (
              <button
                key={t.id}
                onClick={() => pick(t)}
                className="flex w-full items-start gap-2.5 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent"
              >
                <FileText size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-foreground">{t.name}</div>
                  {t.description ? (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{t.description}</p>
                  ) : null}
                  {t.sql_text ? (
                    <pre className="mt-1.5 max-h-12 overflow-hidden rounded bg-muted px-2 py-1 font-mono text-[11px] leading-4 text-code-fg">
                      {t.sql_text}
                    </pre>
                  ) : null}
                </div>
              </button>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
