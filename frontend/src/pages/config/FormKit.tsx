import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 配置页共用表单小件（docs/UI设计规范.md 3.7 卡片 + 表单区）。
 * 卡片：白底 / 12px 圆角 / 微阴影 / 标题 13px 600。
 */

export function ConfigCard({
  title,
  hint,
  className,
  children,
}: {
  title: string
  hint?: string
  className?: string
  children: ReactNode
}) {
  return (
    <section className={cn('rounded-xl border bg-card p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)]', className)}>
      <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  )
}

/** 单行字段：左侧 13px label（+hint），右侧控件 */
export function FieldRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-28 shrink-0">
        <div className="text-[13px] text-foreground">{label}</div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** 统一 input 样式（右侧控件） */
export function fieldInputCls(): string {
  return 'h-7 w-full rounded-md border border-input bg-input/20 px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30'
}
