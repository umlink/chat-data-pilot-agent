import { useCallback, useEffect, useState } from 'react'
import { FileText, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import type { Template, TemplateForm } from '@/types/template'

/** 模板管理页：可复用分析配置（数据源 + SQL + 图表），见 docs/技术方案设计.md 3.8 */
export function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [keyword, setKeyword] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Template | null>(null)
  const [deleting, setDeleting] = useState<Template | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [deletingBusy, setDeletingBusy] = useState(false)

  const load = useCallback(async (kw: string) => {
    setLoadError('')
    try {
      const list = await api.get<Template[]>(`/templates?keyword=${encodeURIComponent(kw)}`)
      setTemplates(list)
    } catch (e) {
      // 加载失败与空态区分：显示错误 + 重试，避免误判为「暂无模板」
      setTemplates([])
      setLoadError(e instanceof Error ? e.message : '模板加载失败')
    }
  }, [])

  // 搜索防抖：停止输入 300ms 后再请求，避免连续键入打后端
  useEffect(() => {
    const t = setTimeout(() => void load(keyword), 300)
    return () => clearTimeout(t)
  }, [keyword, load])

  const confirmDelete = async () => {
    if (!deleting) return
    setDeletingBusy(true)
    setDeleteError('')
    try {
      await api.post('/templates/delete', { id: deleting.id })
      setDeleting(null)
      await load(keyword)
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : '删除失败')
    } finally {
      setDeletingBusy(false)
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-6 pb-1 pt-6">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground">模板管理</h2>
          <p className="text-xs text-muted-foreground">可复用的分析配置（数据源 + SQL + 图表）</p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索模板…"
            className="h-7 w-48"
          />
          <Button
            size="sm"
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          >
            <Plus size={14} /> 新建模板
          </Button>
        </div>
      </div>

      <div className="px-6 pb-6 pt-4">
        {loadError ? (
          <div className="flex flex-col items-center gap-3 py-12">
            <p className="text-[13px] text-error">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => void load(keyword)}>
              重试
            </Button>
          </div>
        ) : templates === null ? (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
          </div>
        ) : templates.length === 0 ? (
          <p className="py-12 text-center text-[13px] text-muted-foreground">暂无模板</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {templates.map((t) => (
              <div
                key={t.id}
                className="rounded-xl border bg-card p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
              >
                <div className="flex items-center gap-2">
                  <FileText size={15} className="shrink-0 text-muted-foreground" />
                  <span className="truncate text-[13px] font-semibold text-foreground">{t.name}</span>
                  <div className="ml-auto flex gap-1">
                    <button
                      className="btn btn-ghost btn-sm"
                      aria-label={`编辑 ${t.name}`}
                      title="编辑"
                      onClick={() => {
                        setEditing(t)
                        setDialogOpen(true)
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="btn btn-ghost btn-sm text-destructive"
                      aria-label={`删除 ${t.name}`}
                      title="删除"
                      onClick={() => {
                        setDeleteError('')
                        setDeleting(t)
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                {t.description && (
                  <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{t.description}</p>
                )}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {t.sql_text && (
                    <span className="badge badge-outline font-mono text-[10px]">
                      SQL {t.sql_text.length} 字符
                    </span>
                  )}
                  {t.chart_config && (
                    <span className="badge badge-secondary">图表</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <TemplateFormDialog
        open={dialogOpen}
        initial={editing}
        onClose={() => setDialogOpen(false)}
        onSaved={async () => {
          setDialogOpen(false)
          await load(keyword)
        }}
      />

      <Dialog open={deleting !== null} onOpenChange={(v) => !v && setDeleting(null)}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="text-[15px] font-semibold">删除模板</DialogTitle>
          </DialogHeader>
          <p className="text-[13px] text-muted-foreground">
            确定删除模板「{deleting?.name}」？此操作不可恢复。
          </p>
          {deleteError && <p className="text-[13px] text-error">{deleteError}</p>}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleting(null)} disabled={deletingBusy}>
              取消
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void confirmDelete()} disabled={deletingBusy}>
              {deletingBusy ? '删除中…' : '删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function TemplateFormDialog({
  open,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean
  initial: Template | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [form, setForm] = useState<TemplateForm>({ name: '', description: '', sql_text: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    if (initial) {
      setForm({
        name: initial.name,
        description: initial.description ?? '',
        sql_text: initial.sql_text ?? '',
        datasource_id: initial.datasource_id ?? '',
      })
    } else {
      setForm({ name: '', description: '', sql_text: '' })
    }
    setError('')
  }, [open, initial])

  const submit = async () => {
    if (!form.name.trim()) {
      setError('请输入模板名称')
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description?.trim() || null,
        sql_text: form.sql_text?.trim() || null,
        ...(form.datasource_id ? { datasource_id: form.datasource_id } : {}),
      }
      if (initial) {
        await api.post('/templates/update', { id: initial.id, ...payload })
      } else {
        await api.post('/templates', payload)
      }
      await onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-semibold">
            {initial ? '编辑模板' : '新建模板'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-[13px]">模板名称</Label>
            <Input
              value={form.name}
              placeholder="如：月度销售趋势"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[13px]">说明</Label>
            <Input
              value={form.description ?? ''}
              placeholder="模板用途说明（可选）"
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[13px]">SQL</Label>
            <Textarea
              value={form.sql_text ?? ''}
              rows={4}
              placeholder="SELECT ..."
              className="font-mono text-xs"
              onChange={(e) => setForm({ ...form, sql_text: e.target.value })}
            />
          </div>
          {error && <p className="text-[13px] text-error">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
