import { useEffect, useMemo, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import type { DataSourceInfo } from '@/store/dataSourceStore'
import type { ChannelInfo } from '@/types/notification'
import type { AutomationDraft } from '@/types/automation'

interface Props {
  open: boolean
  datasources: DataSourceInfo[]
  channels: ChannelInfo[]
  onOpenChange: (open: boolean) => void
  onSaved: () => void
  /** 失败态「改用表单」入口 */
  onUseForm: () => void
}

/** 自然语言创建定时任务（方案 §3.2/§4.1）：智能解析 → 待确认卡（数据源锁定，改则重解析）→ 确认创建。 */
export function AutomationParseDialog({
  open,
  datasources,
  channels,
  onOpenChange,
  onSaved,
  onUseForm,
}: Props) {
  const [description, setDescription] = useState('')
  const [datasourceId, setDatasourceId] = useState('')
  const [draft, setDraft] = useState<AutomationDraft | null>(null)
  const [parseLoading, setParseLoading] = useState(false)
  const [parseError, setParseError] = useState('')
  const [cron, setCron] = useState('')
  const [sql, setSql] = useState('')
  const [successChannel, setSuccessChannel] = useState('')
  const [failureChannel, setFailureChannel] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

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
    if (!open) return
    setDescription('')
    setDraft(null)
    setParseError('')
    setSaveError('')
    // 数据源默认取第一个（方案：默认当前会话/最近使用的数据源，此处用首个）
    setDatasourceId(datasources[0]?.id ?? '')
  }, [open, datasources])

  const parse = async () => {
    if (parseLoading) return
    if (!description.trim()) {
      setParseError('请输入任务描述')
      return
    }
    if (!datasourceId) {
      setParseError('请先选择数据源（解析需基于该数据源的表结构生成 SQL）')
      return
    }
    setParseLoading(true)
    setParseError('')
    setDraft(null)
    try {
      const d = await api.post<AutomationDraft>('/automations/parse', {
        description: description.trim(),
        datasource_id: datasourceId,
      })
      setDraft(d)
      setCron(d.cron_expression)
      setSql(d.params.sql_text)
      setSuccessChannel(d.notification?.on_success?.channel_id ?? '')
      setFailureChannel(d.notification?.on_failure?.channel_id ?? '')
    } catch (e) {
      setParseError(e instanceof Error ? e.message : '智能解析失败')
    } finally {
      setParseLoading(false)
    }
  }

  /** 数据源变更 → 清空解析结果，必须重新解析（方案 §2.8：改源须重解析，防 SQL 与目标 schema 错配） */
  const changeDatasource = (v: string) => {
    setDatasourceId(String(v ?? ''))
    setDraft(null)
    setParseError('')
  }

  const confirmCreate = async () => {
    if (saving || !draft) return
    if (!cron.trim() || !sql.trim()) {
      setSaveError('cron 与 SQL 不能为空，请检查后确认')
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      const notification = draft.notification
        ? {
            on_success: {
              enabled: !!draft.notification.on_success.enabled,
              channel_id: draft.notification.on_success.enabled ? successChannel || null : null,
            },
            on_failure: {
              enabled: !!draft.notification.on_failure.enabled,
              channel_id: draft.notification.on_failure.enabled ? failureChannel || null : null,
            },
          }
        : null
      await api.post('/automations', {
        name: draft.name,
        description: draft.description,
        params: { ...draft.params, sql_text: sql, datasource_id: datasourceId },
        cron_expression: cron,
        timezone: draft.timezone,
        enabled: true,
        notification,
      })
      onOpenChange(false)
      onSaved()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : '创建失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>智能创建定时任务</DialogTitle>
          <DialogDescription>
            用自然语言描述任务，系统解析为待确认结构；确认前不落库
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="parse-desc">任务描述</Label>
            <Textarea
              id="parse-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="如：每天早上 9 点汇总昨日各渠道销售额，并发送到飞书群"
              className="min-h-[72px] text-[13px]"
            />
          </div>

          <div className="grid gap-1.5">
            <Label>数据源（解析基于其表结构生成 SQL，确认后锁定）</Label>
            <Select value={datasourceId} items={datasourceItems} onValueChange={changeDatasource}>
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
            <p className="text-[11px] text-muted-foreground">
              解析后如需更换数据源，SQL 将作废并需重新解析
            </p>
          </div>

          <Button onClick={() => void parse()} disabled={parseLoading}>
            {parseLoading ? <Loader2 className="size-4 animate-spin" /> : <Sparkles size={15} />}
            {parseLoading ? '解析中…' : '智能解析'}
          </Button>

          {parseError && (
            <div className="rounded-lg border border-error/30 bg-error-bg px-3 py-2 text-[13px] text-error">
              {parseError}
              <button
                onClick={onUseForm}
                className="ml-2 underline decoration-dotted underline-offset-2 hover:text-foreground"
              >
                改用表单创建
              </button>
            </div>
          )}

          {draft && (
            <div className="space-y-3 rounded-lg border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[13px] font-semibold text-foreground">{draft.name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {draft.readable ?? draft.cron_expression} · {draft.datasource_name ?? '—'}
                  </div>
                </div>
                {draft.notification && (
                  <div className="shrink-0 rounded bg-secondary px-2 py-1 text-[11px] text-muted-foreground">
                    {draft.notification.on_success.enabled && draft.notification.on_failure.enabled
                      ? '成功/失败均通知'
                      : draft.notification.on_success.enabled
                        ? '成功时通知'
                        : draft.notification.on_failure.enabled
                          ? '失败时通知'
                          : ''}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="parse-cron">cron 表达式</Label>
                  <Input
                    id="parse-cron"
                    value={cron}
                    onChange={(e) => setCron(e.target.value)}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="parse-name">任务名称</Label>
                  <Input
                    id="parse-name"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    maxLength={100}
                  />
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="parse-sql">查询 SQL（可编辑，仅单条 SELECT）</Label>
                <Textarea
                  id="parse-sql"
                  value={sql}
                  onChange={(e) => setSql(e.target.value)}
                  className="min-h-[72px] font-mono text-xs"
                />
              </div>

              {draft.notification?.on_success.enabled && (
                <div className="flex items-center gap-3">
                  <span className="shrink-0 text-[13px] text-foreground">成功通知渠道</span>
                  <Select
                    value={successChannel}
                    items={channelItems}
                    onValueChange={(v) => setSuccessChannel(String(v ?? ''))}
                  >
                    <SelectTrigger className="flex-1">
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
                </div>
              )}
              {draft.notification?.on_failure.enabled && (
                <div className="flex items-center gap-3">
                  <span className="shrink-0 text-[13px] text-foreground">失败通知渠道</span>
                  <Select
                    value={failureChannel}
                    items={channelItems}
                    onValueChange={(v) => setFailureChannel(String(v ?? ''))}
                  >
                    <SelectTrigger className="flex-1">
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
                </div>
              )}
              {draft.notification && channels.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  暂无通知渠道，可先到「通知渠道」页添加后再绑定
                </p>
              )}

              {saveError && (
                <p className="text-xs text-error" role="alert">
                  {saveError}
                </p>
              )}

              <DialogFooter className="pt-1">
                <Button variant="outline" onClick={() => void parse()} disabled={parseLoading || saving}>
                  重新解析
                </Button>
                <Button onClick={() => void confirmCreate()} disabled={saving}>
                  {saving ? '创建中…' : '确认创建'}
                </Button>
              </DialogFooter>
            </div>
          )}
        </div>

        {!draft && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
