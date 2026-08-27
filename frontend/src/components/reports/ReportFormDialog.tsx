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
import type { ReportInfo, ScheduleType } from '@/types/analytics'

const SCHEDULE_TYPES: { value: ScheduleType; label: string }[] = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
]

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

const CHART_TYPES = [
  { value: 'bar', label: '柱状图' },
  { value: 'line', label: '折线图' },
  { value: 'pie', label: '饼图' },
  { value: 'scatter', label: '散点图' },
]

const AGG_OPTIONS = [
  { value: 'none', label: '不聚合' },
  { value: 'sum', label: '求和' },
  { value: 'avg', label: '平均' },
  { value: 'count', label: '计数' },
  { value: 'max', label: '最大' },
  { value: 'min', label: '最小' },
]

// Base UI Select 的 SelectValue 默认渲染原始 value（如 UUID / 'daily'），
// 需通过 items 映射才能在 trigger 中显示选中项 label
const SCHEDULE_ITEMS = Object.fromEntries(SCHEDULE_TYPES.map((t) => [t.value, t.label]))
const WEEKDAY_ITEMS = Object.fromEntries(WEEKDAYS.map((d, i) => [String(i), `每${d}`]))
const CHART_TYPE_ITEMS = Object.fromEntries(CHART_TYPES.map((t) => [t.value, t.label]))
const AGG_ITEMS = Object.fromEntries(AGG_OPTIONS.map((o) => [o.value, o.label]))

interface MeasureDraft {
  column: string
  agg: string
}

interface FormDraft {
  name: string
  datasourceId: string // '' = 默认数据源
  sqlText: string
  scheduleType: ScheduleType
  scheduleTime: string
  dayOfWeek: number
  dayOfMonth: number
  enabled: boolean
  withChart: boolean
  chartType: string
  dimension: string
  measures: MeasureDraft[]
}

const EMPTY_DRAFT: FormDraft = {
  name: '',
  datasourceId: '',
  sqlText: '',
  scheduleType: 'daily',
  scheduleTime: '09:00',
  dayOfWeek: 0,
  dayOfMonth: 1,
  enabled: true,
  withChart: false,
  chartType: 'bar',
  dimension: '',
  measures: [{ column: '', agg: 'none' }],
}

function draftFromReport(r: ReportInfo): FormDraft {
  const cfg = r.chart_config
  return {
    name: r.name,
    datasourceId: r.datasource_id ?? '',
    sqlText: r.sql_text,
    scheduleType: r.schedule_type,
    scheduleTime: r.schedule_time,
    dayOfWeek: r.day_of_week ?? 0,
    dayOfMonth: r.day_of_month ?? 1,
    enabled: r.enabled,
    withChart: !!cfg,
    chartType: cfg?.chart_type ?? 'bar',
    dimension: cfg?.dimension ?? '',
    measures: cfg?.measures?.length
      ? cfg.measures.map((m) => ({ column: m.column, agg: m.agg ?? 'none' }))
      : [{ column: '', agg: 'none' }],
  }
}

interface Props {
  open: boolean
  /** 编辑中的报告（null = 新建） */
  editing: ReportInfo | null
  datasources: DataSourceInfo[]
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

/** 定时报告新建/编辑弹窗：基础信息 + SQL（仅 SELECT）+ 计划 + 可选图表快照配置。 */
export function ReportFormDialog({ open, editing, datasources, onOpenChange, onSaved }: Props) {
  const [draft, setDraft] = useState<FormDraft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const datasourceItems = useMemo(
    () => Object.fromEntries(datasources.map((ds) => [ds.id, ds.name])),
    [datasources],
  )

  useEffect(() => {
    if (open) {
      setDraft(editing ? draftFromReport(editing) : EMPTY_DRAFT)
      setError('')
    }
  }, [open, editing])

  const patch = (p: Partial<FormDraft>) => setDraft((d) => ({ ...d, ...p }))

  const submit = async () => {
    if (saving) return
    if (!draft.name.trim()) {
      setError('请输入报告名称')
      return
    }
    if (!draft.sqlText.trim()) {
      setError('请输入查询 SQL')
      return
    }
    if (draft.withChart) {
      if (!draft.dimension.trim()) {
        setError('请输入图表维度列')
        return
      }
      if (draft.measures.some((m) => !m.column.trim())) {
        setError('指标列不能为空，请填写或删除空指标')
        return
      }
    }
    setSaving(true)
    try {
      const chartConfig = draft.withChart
        ? {
            chart_type: draft.chartType,
            dimension: draft.dimension.trim(),
            measures: draft.measures.map((m) => ({
              column: m.column.trim(),
              agg: m.agg === 'none' ? null : m.agg,
              name: null,
            })),
            title: null,
          }
        : null
      const body = {
        ...(editing ? { id: editing.id } : {}),
        name: draft.name.trim(),
        datasource_id: draft.datasourceId || null,
        sql_text: draft.sqlText,
        chart_config: chartConfig,
        enabled: draft.enabled,
        schedule_type: draft.scheduleType,
        schedule_time: draft.scheduleTime,
        day_of_week: draft.scheduleType === 'weekly' ? draft.dayOfWeek : null,
        day_of_month: draft.scheduleType === 'monthly' ? draft.dayOfMonth : null,
      }
      if (editing) {
        await api.post('/reports/update', body)
      } else {
        await api.post('/reports', body)
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
          <DialogTitle>{editing ? '编辑定时报告' : '新建定时报告'}</DialogTitle>
          <DialogDescription>
            按计划自动执行只读 SELECT 查询，结果与图表快照保存在运行历史中
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="report-name">报告名称</Label>
            <Input
              id="report-name"
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="如：每日订单汇总"
              maxLength={100}
            />
          </div>

          <div className="grid gap-1.5">
            <Label>数据源</Label>
            <Select
              value={draft.datasourceId}
              items={datasourceItems}
              onValueChange={(v) => patch({ datasourceId: String(v ?? '') })}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="默认数据源" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">默认数据源</SelectItem>
                {datasources.map((ds) => (
                  <SelectItem key={ds.id} value={ds.id}>
                    {ds.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="report-sql">查询 SQL（仅允许单条 SELECT）</Label>
            <Textarea
              id="report-sql"
              value={draft.sqlText}
              onChange={(e) => patch({ sqlText: e.target.value })}
              placeholder="SELECT date_trunc('day', created_at) AS day, count(*) AS cnt FROM orders GROUP BY 1"
              className="min-h-[96px] font-mono text-xs"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>执行频率</Label>
              <Select
                value={draft.scheduleType}
                items={SCHEDULE_ITEMS}
                onValueChange={(v) => patch({ scheduleType: String(v) as ScheduleType })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULE_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="report-time">执行时间</Label>
              <Input
                id="report-time"
                type="time"
                value={draft.scheduleTime}
                onChange={(e) => patch({ scheduleTime: e.target.value })}
              />
            </div>
          </div>

          {draft.scheduleType === 'weekly' && (
            <div className="grid gap-1.5">
              <Label>执行日</Label>
              <Select
                value={String(draft.dayOfWeek)}
                items={WEEKDAY_ITEMS}
                onValueChange={(v) => patch({ dayOfWeek: Number(v) })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEEKDAYS.map((d, i) => (
                    <SelectItem key={d} value={String(i)}>
                      每{d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {draft.scheduleType === 'monthly' && (
            <div className="grid gap-1.5">
              <Label htmlFor="report-dom">每月几号（1-31，超出当月天数取月末）</Label>
              <Input
                id="report-dom"
                type="number"
                min={1}
                max={31}
                value={draft.dayOfMonth}
                onChange={(e) => patch({ dayOfMonth: Number(e.target.value) || 1 })}
              />
            </div>
          )}

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
                    <Label htmlFor="report-dimension">维度列（X 轴）</Label>
                    <Input
                      id="report-dimension"
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
                        value={m.column}
                        onChange={(e) => {
                          const measures = [...draft.measures]
                          measures[i] = { ...m, column: e.target.value }
                          patch({ measures })
                        }}
                        placeholder="列名，如 cnt / amount"
                        aria-label={`指标列 ${i + 1}`}
                      />
                      <Select
                        value={m.agg}
                        items={AGG_ITEMS}
                        onValueChange={(v) => {
                          const measures = [...draft.measures]
                          measures[i] = { ...m, agg: String(v) }
                          patch({ measures })
                        }}
                      >
                        <SelectTrigger className="w-[104px] shrink-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {AGG_OPTIONS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <button
                        onClick={() =>
                          patch({ measures: draft.measures.filter((_, j) => j !== i) })
                        }
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
                    onClick={() => patch({ measures: [...draft.measures, { column: '', agg: 'none' }] })}
                  >
                    <Plus size={13} /> 添加指标
                  </Button>
                </div>
              </div>
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
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? '保存中…' : editing ? '保存修改' : '创建报告'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
