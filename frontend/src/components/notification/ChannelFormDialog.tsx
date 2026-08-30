import { useEffect, useMemo, useState } from 'react'
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
import { MaskedInput } from '@/components/datasource/MaskedInput'
import { MASKED } from '@/types/config'
import type { ChannelInfo, NotificationProvider } from '@/types/notification'

interface ConfigField {
  key: string
  label: string
  type: 'text' | 'password' | 'number' | 'switch' | 'list'
}

const PROVIDER_FIELDS: Record<string, ConfigField[]> = {
  feishu: [
    { key: 'webhook_url', label: 'Webhook 地址', type: 'password' },
    { key: 'secret', label: '签名密钥（可选）', type: 'password' },
  ],
  wecom: [{ key: 'webhook_url', label: 'Webhook 地址', type: 'password' }],
  dingtalk: [
    { key: 'webhook_url', label: 'Webhook 地址', type: 'password' },
    { key: 'secret', label: '加签密钥', type: 'password' },
  ],
  email: [
    { key: 'smtp_host', label: 'SMTP 主机', type: 'text' },
    { key: 'smtp_port', label: '端口（默认 465）', type: 'number' },
    { key: 'username', label: '用户名', type: 'password' },
    { key: 'password', label: '密码', type: 'password' },
    { key: 'use_tls', label: '启用 STARTTLS（587 时）', type: 'switch' },
    { key: 'from', label: '发件人地址', type: 'text' },
    { key: 'to', label: '收件人（逗号分隔）', type: 'list' },
  ],
}

const PROVIDER_OPTIONS = [
  { value: 'email', label: '邮件' },
  { value: 'feishu', label: '飞书' },
  { value: 'wecom', label: '企业微信' },
  { value: 'dingtalk', label: '钉钉' },
]
const PROVIDER_ITEMS = Object.fromEntries(PROVIDER_OPTIONS.map((p) => [p.value, p.label]))

interface Props {
  open: boolean
  editing: ChannelInfo | null
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

/** 通知渠道新增/编辑弹窗：provider 动态字段；敏感字段掩码（留空=保留旧值）。 */
export function ChannelFormDialog({ open, editing, onOpenChange, onSaved }: Props) {
  const [name, setName] = useState('')
  const [provider, setProvider] = useState<NotificationProvider>('feishu')
  const [config, setConfig] = useState<Record<string, string>>({})
  const [enabled, setEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const fields = useMemo(() => PROVIDER_FIELDS[provider] ?? [], [provider])

  useEffect(() => {
    if (!open) return
    setError('')
    if (editing) {
      setName(editing.name)
      setProvider(editing.provider as NotificationProvider)
      // config 出参已掩码；数组字段（收件人）转逗号分隔便于编辑
      const cfg: Record<string, string> = {}
      for (const [k, v] of Object.entries(editing.config)) {
        cfg[k] = Array.isArray(v) ? (v as string[]).join(', ') : String(v)
      }
      setConfig(cfg)
      setEnabled(editing.enabled)
    } else {
      setName('')
      setProvider('feishu')
      setConfig({})
      setEnabled(true)
    }
  }, [open, editing])

  const switchProvider = (v: string) => {
    setProvider(v as NotificationProvider)
    setConfig({})
  }

  const patchConfig = (key: string, value: string) =>
    setConfig((c) => ({ ...c, [key]: value }))

  const submit = async () => {
    if (saving) return
    if (!name.trim()) {
      setError('请输入渠道名称')
      return
    }
    const cfg: Record<string, unknown> = {}
    for (const f of fields) {
      const raw = config[f.key] ?? ''
      if (f.key === 'to') {
        cfg[f.key] = raw.split(',').map((s) => s.trim()).filter(Boolean)
      } else if (f.key === 'smtp_port') {
        cfg[f.key] = Number(raw) || 465
      } else if (f.type === 'switch') {
        cfg[f.key] = raw === 'true'
      } else if (raw !== '') {
        cfg[f.key] = raw
      } else if (!editing) {
        // 新建：空值也提交，交由后端校验必填
        cfg[f.key] = ''
      }
      // 编辑时字段为空 → 不放进 config（后端仅合并传入 key，旧密文/旧值保留）
    }
    setSaving(true)
    try {
      if (editing) {
        await api.post('/notifications/channels/update', {
          id: editing.id,
          name: name.trim(),
          config: cfg,
          enabled,
        })
      } else {
        await api.post('/notifications/channels', {
          name: name.trim(),
          provider,
          config: cfg,
        })
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
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑通知渠道' : '新增通知渠道'}</DialogTitle>
          <DialogDescription>
            配置第三方通知发送；敏感字段已加密存储，编辑时留空表示保留原值
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="channel-name">渠道名称</Label>
              <Input
                id="channel-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：数据组飞书群"
                maxLength={100}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>类型</Label>
              <Select
                value={provider}
                items={PROVIDER_ITEMS}
                onValueChange={switchProvider}
                disabled={!!editing}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_OPTIONS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {fields.map((f) => (
            <div key={f.key} className="grid gap-1.5">
              <Label>{f.label}</Label>
              {f.type === 'switch' ? (
                <div className="flex items-center gap-2">
                  <Switch
                    checked={config[f.key] === 'true'}
                    onCheckedChange={(v) => patchConfig(f.key, String(v))}
                    aria-label={f.label}
                  />
                  <span className="text-xs text-muted-foreground">{config[f.key] === 'true' ? '已启用' : '未启用'}</span>
                </div>
              ) : f.type === 'password' ? (
                <MaskedInput
                  value={config[f.key] ?? ''}
                  onChange={(v) => patchConfig(f.key, v)}
                  placeholder={f.key === 'webhook_url' ? 'https://…' : f.label}
                />
              ) : (
                <Input
                  value={config[f.key] ?? ''}
                  onChange={(e) => patchConfig(f.key, e.target.value)}
                  placeholder={f.type === 'list' ? 'a@x.com, b@y.com' : f.type === 'number' ? '465' : undefined}
                  type={f.type === 'number' ? 'number' : 'text'}
                />
              )}
              {f.type === 'password' && config[f.key] === MASKED && (
                <p className="text-[11px] text-muted-foreground">已配置，留空保存不覆盖旧值</p>
              )}
            </div>
          ))}
        </div>

        {editing && (
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <div className="text-[13px] font-medium text-foreground">启用渠道</div>
              <div className="text-[11px] text-muted-foreground">
                停用后定时任务将不再向该渠道发送（恢复启用后自动恢复）
              </div>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="启用渠道"
            />
          </div>
        )}

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
            {saving ? '保存中…' : editing ? '保存修改' : '创建渠道'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
