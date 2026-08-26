import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MASKED } from '@/types/config'
import type { LlmProvider, LlmProviderForm } from '@/types/llmProvider'

interface Props {
  open: boolean
  /** 编辑时传入；新增为 undefined */
  initial?: LlmProvider | null
  onClose: () => void
  onSubmit: (form: LlmProviderForm) => Promise<void> | void
}

const EMPTY: LlmProviderForm = {
  name: '',
  type: 'openai',
  base_url: '',
  api_key: '',
  models: [],
  default_model: '',
}

/** LLM 供应商新建/编辑弹窗（docs/UI设计规范.md 3.13：API Key 留空/掩码=保留旧值）
 *  模型为单输入框：models=[model]、default_model=model（后端契约为数组，此处提交单元素数组） */
export function ProviderFormDialog({ open, initial, onClose, onSubmit }: Props) {
  const [form, setForm] = useState<LlmProviderForm>(EMPTY)
  const [model, setModel] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    if (initial) {
      setForm({
        name: initial.name,
        type: initial.type,
        base_url: initial.base_url,
        api_key: '', // 编辑时留空 = 保留旧值
        models: initial.models,
        default_model: initial.default_model,
      })
      setModel(initial.models[0] ?? '')
    } else {
      setForm(EMPTY)
      setModel('')
    }
    setError('')
  }, [open, initial])

  const modelName = model.trim()

  const submit = async () => {
    if (!form.name.trim()) {
      setError('请输入供应商名称')
      return
    }
    if (!modelName) {
      setError('请输入模型名称')
      return
    }
    const payload: LlmProviderForm = {
      ...form,
      models: [modelName],
      default_model: modelName,
      // 编辑时保持掩码语义：未输入则传 MASKED（后端保留旧值）；新增时空串
      api_key: initial ? form.api_key || MASKED : form.api_key,
    }
    setSaving(true)
    try {
      await onSubmit(payload)
      onClose()
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
          <DialogTitle className="text-[15px] font-semibold">{initial ? '编辑供应商' : '新增 LLM 供应商'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-[13px]">供应商名称</Label>
            <Input
              value={form.name}
              placeholder="如：DeepSeek 主力"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[13px]">协议类型</Label>
            <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v as LlmProviderForm['type'] })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI（含兼容协议）</SelectItem>
                <SelectItem value="anthropic">Anthropic</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[13px]">Base URL</Label>
            <Input
              value={form.base_url}
              placeholder="https://api.deepseek.com/v1 或留空用官方默认"
              onChange={(e) => setForm({ ...form, base_url: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[13px]">API Key</Label>
            <Input
              type="password"
              value={form.api_key}
              placeholder={initial ? '已保存（留空不修改）' : 'sk-…'}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[13px]">模型名称</Label>
            <Input
              value={model}
              placeholder="deepseek-chat"
              onChange={(e) => setModel(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">该模型即默认使用模型</p>
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
