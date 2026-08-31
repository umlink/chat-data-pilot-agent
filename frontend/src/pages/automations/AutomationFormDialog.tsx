import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { DataSourceInfo } from '@/store/dataSourceStore'
import type { ChannelInfo } from '@/types/notification'
import type { AutomationInfo } from '@/types/automation'

const CHART_TYPES = [
  { value: 'bar', label: '柱状图' },
  { value: 'line', label: '折线图' },
  { value: 'pie', label: '饼图' },
  { value: 'scatter', label: '散点图' },
  { value: 'heatmap', label: '热力图' },
]
const CHART_TYPE_ITEMS = Object.fromEntries(CHART_TYPES.map((t) => [t.value, t.label]))

/** 5 段 cron 基本校验（分 时 日 月 周）：每段非空，由数字 / * / - / , / 组合（宽松校验，不校验取值域） */
function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  return fields.every((f) => /^(\*|\d+)([-,/](\*|\d+))*$/.test(f))
}

interface VarPair {
  key: string
  value: string
}

interface FormDraft {
  name: string
  description: string
  datasourceId: string
  cronExpression: string
  sqlText: string
  variableDefaults: VarPair[]
  withChart: boolean
  chartType: string
  dimension: string
  measures: string[]
  notifySuccess: boolean
  notifySuccessChannel: string
  notifyFailure: boolean
  notifyFailureChannel: string
  enabled: boolean
}

const EMPTY_DRAFT: FormDraft = {
  name: '',
  description: '',
  datasourceId: '',
  cronExpression: '0 9 * * *',
  sqlText: '',
  variableDefaults: [],
  withChart: false,
  chartType: 'bar',
  dimension: '',
  measures: [''],
  notifySuccess: false,
  notifySuccessChannel: '',
  notifyFailure: false,
  notifyFailureChannel: '',
  enabled: true,
}

function varsToPairs(vars?: Record<string, string>): VarPair[] {
  return Object.entries(vars ?? {}).map(([k, v]) => ({ key: k, value: v }))
}

function draftFromAutomation(a: AutomationInfo): FormDraft {
  const cfg = a.params.chart_config
  const notify = a.notification
  return {
    name: a.name,
    description: a.description ?? '',
    datasourceId: a.params.datasource_id ?? '',
    cronExpression: a.cron_expression,
    sqlText: a.params.sql_text,
    variableDefaults: varsToPairs(a.params.variable_defaults),
    withChart: !!cfg,
    chartType: cfg?.chart_type ?? 'bar',
    dimension: cfg?.dimension ?? '',
    measures: cfg?.measures?.length ? [...cfg.measures] : [''],
    notifySuccess: !!notify?.on_success?.enabled,
    notifySuccessChannel: notify?.on_success?.channel_id ?? '',
    notifyFailure: !!notify?.on_failure?.enabled,
    notifyFailureChannel: notify?.on_failure?.channel_id ?? '',
    enabled: a.enabled,
  }
}

interface Props {
  open: boolean
  /** 编辑中的任务（null = 新建） */
  editing: AutomationInfo | null
  datasources: DataSourceInfo[]
  channels: ChannelInfo[]
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

/** 定时任务新建/编辑弹窗：cron + 参数模板（SQL/变量/图表）+ 通知绑定 + 数据源必选。 */
export function AutomationFormDialog({
  open,
  editing,
  datasources,
  channels,
  onOpenChange,
  onSaved,
}: Props) {
  const [draft, setDraft] = useState<FormDraft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const datasourceItems = useMemo(
    () => Object.fromEntries(datasources.map((ds) => [ds.id, ds.name])),
    [datasources],
  )
  const channelItems = useMemo(() => {
    const m: Record<string, string> = {}
    for (const c of channels) m[c.id] = `${c.name}（${c.enabled ? '启用' : '停用'}）`
    return m
  }, [channels])

  useEffect(() => {
    if (open) {
      setDraft(editing ? draftFromAutomation(editing) : EMPTY_DRAFT)
      setError('')
    }
  }, [open, editing])

  const patch = (p: Partial<FormDraft>) => setDraft((d) => ({ ...d, ...p }))

  // cron 实时校验：非法时禁用保存并在字段下方内联提示
  const cronInvalid = !isValidCron(draft.cronExpression)

  const submit = async () => {
    if (saving) return
    if (!draft.name.trim()) {
      setError('请输入任务名称')
      return
    }
    if (!draft.datasourceId) {
      setError('请选择数据源（定时任务必须绑定数据源）')
      return
    }
    if (!datasourceItems[draft.datasourceId]) {
      setError('所选数据源不存在或已被删除，请重新选择')
      return
    }
    if (!isValidCron(draft.cronExpression)) {
      setError('cron 格式不正确（如：0 9 * * 1-5）')
      return
    }
    if (!draft.sqlText.trim()) {
      setError('请输入查询 SQL')
      return
    }
    // 勾选了成功/失败通知但未选通知渠道时阻止提交
    if (
      (draft.notifySuccess && !draft.notifySuccessChannel) ||
      (draft.notifyFailure && !draft.notifyFailureChannel)
    ) {
      setError('请先选择通知渠道')
      return
    }
    // 通知渠道被删除后悬空引用：阻止带病提交（显示 UUID 无意义）
    if (draft.notifySuccess && !channelItems[draft.notifySuccessChannel]) {
      setError('所选成功通知渠道不存在或已被删除，请重新选择')
      return
    }
    if (draft.notifyFailure && !channelItems[draft.notifyFailureChannel]) {
      setError('所选失败通知渠道不存在或已被删除，请重新选择')
      return
    }
    if (draft.withChart) {
      if (!draft.dimension.trim()) {
        setError('请输入图表维度列')
        return
      }
      if (draft.measures.some((m) => !m.trim())) {
        setError('指标列不能为空，请填写或删除空指标')
        return
      }
    }
    const variableDefaults: Record<string, string> = {}
    for (const v of draft.variableDefaults) {
      if (v.key.trim()) variableDefaults[v.key.trim()] = v.value
    }
    const chartConfig = draft.withChart
      ? {
          chart_type: draft.chartType,
          dimension: draft.dimension.trim(),
          measures: draft.measures.map((m) => m.trim()).filter(Boolean),
          title: null,
        }
      : null
    const notification =
      draft.notifySuccess || draft.notifyFailure
        ? {
            on_success: {
              enabled: draft.notifySuccess,
              channel_id: draft.notifySuccess ? draft.notifySuccessChannel || null : null,
            },
            on_failure: {
              enabled: draft.notifyFailure,
              channel_id: draft.notifyFailure ? draft.notifyFailureChannel || null : null,
            },
          }
        : null
    const body = {
      ...(editing ? { id: editing.id } : {}),
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      params: {
        sql_text: draft.sqlText,
        datasource_id: draft.datasourceId,
        variable_defaults: variableDefaults,
        ...(chartConfig ? { chart_config: chartConfig } : {}),
      },
      cron_expression: draft.cronExpression.trim(),
      enabled: draft.enabled,
      notification,
    }
    setSaving(true)
    try {
      if (editing) {
        await api.post('/automations/update', body)
      } else {
        await api.post('/automations', body)
      }
      onOpenChange(false)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑定时任务' : '新建定时任务'}</DialogTitle>
          <DialogDescription>
            按 cron 计划自动执行只读 SELECT 查询，支持 {'${变量}'} 参数模板与可选图表快照
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="automation-name">任务名称</Label>
              <Input
                id="automation-name"
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="如：每日销售额汇总"
                maxLength={100}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="automation-cron">cron 表达式</Label>
              <Input
                id="automation-cron"
                value={draft.cronExpression}
                onChange={(e) => patch({ cronExpression: e.target.value })}
                placeholder="分 时 日 月 周，如 0 9 * * *"
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                5 段 cron（分 时 日 月 周）；周 0/7=周日。如：0 9 * * * 每天 09:00
              </p>
              {cronInvalid && (
                <p className="text-[11px] text-error">cron 格式不正确（如：0 9 * * 1-5）</p>
              )}
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="automation-desc">描述（可选）</Label>
            <Input
              id="automation-desc"
              value={draft.description}
              onChange={(e) => patch({ description: e.target.value })}
              placeholder="该任务的用途说明"
            />
          </div>

          <div className="grid gap-1.5">
            <Label>数据源（必选）</Label>
            <Select
              value={draft.datasourceId}
              items={datasourceItems}
              onValueChange={(v) => patch({ datasourceId: String(v ?? '') })}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="请选择数据源" />
              </SelectTrigger>
              <SelectContent>
                {datasources.map((ds) => (
                  <SelectItem key={ds.id} value={ds.id}>
                    {ds.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="automation-sql">查询 SQL（仅允许单条 SELECT）</Label>
            <Textarea
              id="automation-sql"
              value={draft.sqlText}
              onChange={(e) => patch({ sqlText: e.target.value })}
              placeholder="SELECT count(*) FROM orders WHERE created_at >= ${yesterday}"
              className="min-h-[88px] font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              动态日期可用内置占位符：{'{yesterday}'} {'{today}'} {'{this_month_start}'} {'{last_month_end}'} 等
            </p>
          </div>

          <div className="rounded-lg border p-3">
            <div className="text-[13px] font-medium text-foreground">参数模板（用户变量默认值）</div>
            <p className="mb-2 text-[11px] text-muted-foreground">
              定义 SQL 中 {'${var}'} 占位符的默认值；内置变量无需定义
            </p>
            {draft.variableDefaults.map((v, i) => (
              <div key={i} className="mb-2 flex items-center gap-2">
                <Input
                  value={v.key}
                  onChange={(e) => {
                    const list = [...draft.variableDefaults]
                    list[i] = { ...v, key: e.target.value }
                    patch({ variableDefaults: list })
                  }}
                  placeholder="变量名，如 start_date"
                  aria-label={`变量名 ${i + 1}`}
                  className="font-mono text-xs"
                />
                <Input
                  value={v.value}
                  onChange={(e) => {
                    const list = [...draft.variableDefaults]
                    list[i] = { ...v, value: e.target.value }
                    patch({ variableDefaults: list })
                  }}
                  placeholder="默认值"
                  aria-label={`变量默认值 ${i + 1}`}
                  className="font-mono text-xs"
                />
                <button
                  onClick={() => patch({ variableDefaults: draft.variableDefaults.filter((_, j) => j !== i) })}
                  disabled={draft.variableDefaults.length <= 1}
                  aria-label="删除变量"
                  className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-error disabled:opacity-40"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => patch({ variableDefaults: [...draft.variableDefaults, { key: '', value: '' }] })}
            >
              <Plus size={13} /> 添加变量
            </Button>
          </div>

          <div className="rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium text-foreground">生成图表快照</div>
                <div className="text-[11px] text-muted-foreground">运行后按维度/指标聚合生成图表，便于查看趋势</div>
              </div>
              <Switch
                checked={draft.withChart}
                onCheckedChange={(v) => patch({ withChart: v })}
                aria-label="生成图表快照"
              />
            </div>
            {draft.withChart && (
              <div className="mt-3 grid gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label>图表类型</Label>
                    <Select
                      value={draft.chartType}
                      items={CHART_TYPE_ITEMS}
                      onValueChange={(v) => patch({ chartType: String(v) })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CHART_TYPES.map((t) => (
                          <SelectItem key={t.value} value={t.value}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="automation-dimension">维度列（X 轴）</Label>
                    <Input
                      id="automation-dimension"
                      value={draft.dimension}
                      onChange={(e) => patch({ dimension: e.target.value })}
                      placeholder="如 day / category"
                    />
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label>指标列（Y 轴，可多个）</Label>
                  {draft.measures.map((m, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        value={m}
                        onChange={(e) => {
                          const list = [...draft.measures]
                          list[i] = e.target.value
                          patch({ measures: list })
                        }}
                        placeholder="列名，如 cnt / amount"
                        aria-label={`指标列 ${i + 1}`}
                      />
                      <button
                        onClick={() => patch({ measures: draft.measures.filter((_, j) => j !== i) })}
                        disabled={draft.measures.length <= 1}
                        aria-label="删除指标"
                        title="删除指标"
                        className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-error disabled:opacity-40"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-fit"
                    onClick={() => patch({ measures: [...draft.measures, ''] })}
                  >
                    <Plus size={13} /> 添加指标
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-lg border p-3">
            <div className="mb-2 text-[13px] font-medium text-foreground">运行结果通知</div>
            <div className="grid gap-3">
              <div className="flex items-center gap-3">
                <Switch
                  checked={draft.notifySuccess}
                  onCheckedChange={(v) => patch({ notifySuccess: v })}
                  aria-label="成功时通知"
                />
                <span className="flex-1 text-[13px] text-foreground">执行成功时通知</span>
                {draft.notifySuccess && (
                  <Select
                    value={draft.notifySuccessChannel}
                    items={channelItems}
                    onValueChange={(v) => patch({ notifySuccessChannel: String(v ?? '') })}
                  >
                    <SelectTrigger className="w-[180px]">
                      <SelectValue placeholder="选择渠道" />
                    </SelectTrigger>
                    <SelectContent>
                      {channels.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  checked={draft.notifyFailure}
                  onCheckedChange={(v) => patch({ notifyFailure: v })}
                  aria-label="失败时通知"
                />
                <span className="flex-1 text-[13px] text-foreground">执行失败时通知</span>
                {draft.notifyFailure && (
                  <Select
                    value={draft.notifyFailureChannel}
                    items={channelItems}
                    onValueChange={(v) => patch({ notifyFailureChannel: String(v ?? '') })}
                  >
                    <SelectTrigger className="w-[180px]">
                      <SelectValue placeholder="选择渠道" />
                    </SelectTrigger>
                    <SelectContent>
                      {channels.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>
            {channels.length === 0 && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                暂无通知渠道，可先在「通知渠道」页添加
              </p>
            )}
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <div className="text-[13px] font-medium text-foreground">启用调度</div>
              <div className="text-[11px] text-muted-foreground">关闭后保留配置，不再自动执行</div>
            </div>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(v) => patch({ enabled: v })}
              aria-label="启用调度"
            />
          </div>
        </div>

        {error && (
          <p className="text-xs text-error" role="alert">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={saving || cronInvalid}>
            {saving ? '保存中…' : editing ? '保存修改' : '创建任务'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
