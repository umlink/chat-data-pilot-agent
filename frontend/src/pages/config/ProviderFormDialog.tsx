import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MASKED } from '@/types/config'
import { MaskedInput } from '@/components/common/MaskedInput'
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

// Base UI Select 的 SelectValue 默认渲染原始 value（如 openai），
// 需通过 items 映射才能在 trigger 中显示选中项 label
const TYPE_ITEMS: Record<string, string> = {
  openai: 'OpenAI（含兼容协议）',
  anthropic: 'Anthropic',
}

/** LLM 供应商新建/编辑弹窗（docs/UI设计规范.md 3.13：API Key 留空/掩码=保留旧值）
 *  支持维护多个模型并指定默认模型（后端契约为数组，避免编辑时截断丢模型）。 */
export function ProviderFormDialog({ open, initial, onClose, onSubmit }: Props) {
  const [form, setForm] = useState<LlmProviderForm>(EMPTY)
  const [models, setModels] = useState<string[]>([])
  const [modelInput, setModelInput] = useState('')
  const [defaultModel, setDefaultModel] = useState('')
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
      setModels(initial.models)
      setDefaultModel(initial.default_model || initial.models[0] || '')
    } else {
      setForm(EMPTY)
      setModels([])
      setModelInput('')
      setDefaultModel('')
    }
    setError('')
  }, [open, initial])

  const addModel = () => {
    const name = modelInput.trim()
    if (!name) return
    setModels((prev) => (prev.includes(name) ? prev : [...prev, name]))
    setModelInput('')
  }

  const removeModel = (name: string) => {
    setModels((prev) => prev.filter((m) => m !== name))
    setDefaultModel((prev) => (prev === name ? '' : prev))
  }

  const submit = async () => {
    if (!form.name.trim()) {
      setError('请输入供应商名称')
      return
    }
    const finalModels = models.map((m) => m.trim()).filter(Boolean)
    if (finalModels.length === 0) {
      setError('请至少添加一个模型名称')
      return
    }
    const payload: LlmProviderForm = {
      ...form,
      models: finalModels,
      default_model: defaultModel || finalModels[0],
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

  const MODEL_ITEMS = Object.fromEntries(models.map((m) => [m, m]))

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
            <Select value={form.type} items={TYPE_ITEMS} onValueChange={(v) => setForm({ ...form, type: v as LlmProviderForm['type'] })}>
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
            <MaskedInput
              value={form.api_key}
              onChange={(v) => setForm({ ...form, api_key: v })}
              placeholder={initial ? '已保存（留空不修改）' : 'sk-…'}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[13px]">模型名称</Label>
            <div className="flex gap-2">
              <Input
                value={modelInput}
                placeholder="如：deepseek-chat"
                onChange={(e) => setModelInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addModel()
                  }
                }}
              />
              <Button size="sm" variant="outline" onClick={addModel} disabled={!modelInput.trim()}>
                添加
              </Button>
            </div>
            {models.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {models.map((m) => (
                  <span
                    key={m}
                    className={`badge ${m === defaultModel ? 'badge-primary' : 'badge-secondary'}`}
                  >
                    {m}
                    <button
                      type="button"
                      aria-label={`移除模型 ${m}`}
                      className="ml-1 text-current opacity-70 hover:opacity-100"
                      onClick={() => removeModel(m)}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">添加一个或多个模型名称</p>
            )}
            {models.length > 1 && (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-[11px] text-muted-foreground">默认模型</span>
                <Select
                  value={defaultModel}
                  items={MODEL_ITEMS}
                  onValueChange={(v) => setDefaultModel(String(v ?? ''))}
                >
                  <SelectTrigger className="h-7 w-44">
                    <SelectValue placeholder="选择默认" />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
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
