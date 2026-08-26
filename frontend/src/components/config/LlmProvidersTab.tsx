import { useEffect, useState } from 'react'
import { Check, Plus, Shield, Sparkles, Trash2, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { useLlmProviderStore } from '@/store/llmProviderStore'
import type { ConfigMap } from '@/types/config'
import type { LlmProvider, ProviderTestResult } from '@/types/llmProvider'
import { ConfigCard, FieldRow, fieldInputCls } from './FormKit'
import { ProviderFormDialog } from './ProviderFormDialog'

interface Props {
  config: ConfigMap
  setField: (key: string, field: string, value: unknown) => void
}

/** 供应商列表 + 生成参数（docs/技术方案设计.md 3.6 / UI设计规范.md 3.13） */
export function LlmProvidersTab({ config, setField }: Props) {
  const providers = useLlmProviderStore((s) => s.providers)
  const loaded = useLlmProviderStore((s) => s.loaded)
  const load = useLlmProviderStore((s) => s.load)
  const create = useLlmProviderStore((s) => s.create)
  const update = useLlmProviderStore((s) => s.update)
  const remove = useLlmProviderStore((s) => s.remove)
  const setDefault = useLlmProviderStore((s) => s.setDefault)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<LlmProvider | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, ProviderTestResult>>({})

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  const runTest = async (p: LlmProvider) => {
    setTestingId(p.id)
    try {
      const r = await api.post<ProviderTestResult>(`/llm/providers/${p.id}/test`)
      setTestResults((prev) => ({ ...prev, [p.id]: r }))
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [p.id]: { ok: false, error: e instanceof Error ? e.message : '测试失败' },
      }))
    } finally {
      setTestingId(null)
    }
  }

  const onDelete = async (p: LlmProvider) => {
    if (!window.confirm(`删除供应商「${p.name}」？${p.is_default ? '默认供应商删除后将自动提升最新一项。' : ''}`)) return
    await remove(p.id)
  }

  const generation = config['llm.provider'] ?? {}

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">可维护多个供应商，其中一个为默认使用；首个创建自动为默认</p>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null)
            setDialogOpen(true)
          }}
        >
          <Plus size={14} /> 新增供应商
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3">
        {providers.map((p) => {
          const testResult = testResults[p.id]
          return (
            <div
              key={p.id}
              className="flex items-center gap-4 rounded-xl border bg-card p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-semibold text-foreground">{p.name}</span>
                  <span className="badge badge-secondary">{p.type === 'anthropic' ? 'Anthropic' : 'OpenAI'}</span>
                  {p.is_default && (
                    <span className="badge badge-primary">
                      <Shield size={11} /> 默认
                    </span>
                  )}
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {p.base_url || '官方默认地址'} · {p.default_model || '未配置模型'}
                  {p.models.length > 1 ? `（共 ${p.models.length} 个模型）` : ''}
                </div>
                {testResult && (
                  <div className="mt-1">
                    {testResult.ok ? (
                      <span className="badge badge-success">
                        ✓ 连接成功 · {testResult.model} · {testResult.latency_ms}ms
                      </span>
                    ) : (
                      <span className="text-xs text-error">{testResult.error ?? '连接失败'}</span>
                    )}
                  </div>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <button
                  className="btn btn-ghost btn-sm"
                  aria-label={`测试 ${p.name}`}
                  title="测试连接"
                  onClick={() => void runTest(p)}
                  disabled={testingId === p.id}
                >
                  <Zap size={13} /> {testingId === p.id ? '测试中' : '测试'}
                </button>
                {!p.is_default && (
                  <button
                    className="btn btn-ghost btn-sm"
                    aria-label={`设为默认 ${p.name}`}
                    title="设为默认供应商"
                    onClick={() => void setDefault(p.id)}
                  >
                    <Check size={13} /> 设为默认
                  </button>
                )}
                <button
                  className="btn btn-ghost btn-sm"
                  aria-label={`编辑 ${p.name}`}
                  title="编辑"
                  onClick={() => {
                    setEditing(p)
                    setDialogOpen(true)
                  }}
                >
                  <Sparkles size={13} /> 编辑
                </button>
                <button
                  className="btn btn-ghost btn-sm text-destructive hover:text-destructive"
                  aria-label={`删除 ${p.name}`}
                  title="删除"
                  onClick={() => void onDelete(p)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          )
        })}
        {loaded && providers.length === 0 && (
          <p className="py-8 text-center text-[13px] text-muted-foreground">暂无供应商，点击「新增供应商」创建第一个</p>
        )}
      </div>

      <ConfigCard title="生成参数" hint="会话级生成参数（llm.provider）：温度 / 限制 / 超时 / 重试">
        <FieldRow label="Temperature" hint="0–2，越大越发散">
          <Input
            type="number"
            step={0.1}
            min={0}
            max={2}
            className={fieldInputCls()}
            value={Number(generation.temperature ?? 0.5)}
            onChange={(e) => setField('llm.provider', 'temperature', Number(e.target.value))}
          />
        </FieldRow>
        <FieldRow label="最大输出 tokens">
          <Input
            type="number"
            min={1}
            className={fieldInputCls()}
            value={Number(generation.max_tokens ?? 4096)}
            onChange={(e) => setField('llm.provider', 'max_tokens', Number(e.target.value))}
          />
        </FieldRow>
        <FieldRow label="超时（秒）">
          <Input
            type="number"
            min={1}
            className={fieldInputCls()}
            value={Number(generation.timeout ?? 60)}
            onChange={(e) => setField('llm.provider', 'timeout', Number(e.target.value))}
          />
        </FieldRow>
        <FieldRow label="重试次数">
          <Input
            type="number"
            min={0}
            className={fieldInputCls()}
            value={Number(generation.retry_count ?? 1)}
            onChange={(e) => setField('llm.provider', 'retry_count', Number(e.target.value))}
          />
        </FieldRow>
        <FieldRow label="流式输出">
          <Switch
            checked={Boolean(generation.stream_enabled ?? true)}
            onCheckedChange={(v) => setField('llm.provider', 'stream_enabled', v)}
          />
        </FieldRow>
      </ConfigCard>

      <ProviderFormDialog
        open={dialogOpen}
        initial={editing}
        onClose={() => setDialogOpen(false)}
        onSubmit={(form) => (editing ? update(editing.id, form) : create(form))}
      />
    </div>
  )
}
