import { useState } from 'react'
import { api } from '@/lib/api'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { DataSourceInfo } from '@/store/dataSourceStore'
import { CONFIG_FIELDS, DATASOURCE_TYPE_OPTIONS, FILE_TYPES, datasourceTypeLabel, type DatasourceType, type TestResult } from './constants'
import { DataSourceConfigFields } from './DataSourceConfigFields'
import { DataSourceFormFooter } from './DataSourceFormFooter'

interface Props {
  open: boolean
  /** 编辑目标；null 表示新建 */
  editing: DataSourceInfo | null
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

function defaultsFor(type: DatasourceType): Record<string, string> {
  const init: Record<string, string> = {}
  for (const f of CONFIG_FIELDS[type]) {
    init[f.name] = f.defaultValue ?? ''
  }
  return init
}

/** 新建 / 编辑数据源：按类型动态渲染连接配置表单，敏感字段掩码保留旧密文。 */
export function DataSourceFormDialog({ open, editing, onOpenChange, onSaved }: Props) {
  const [name, setName] = useState('')
  const [type, setType] = useState<DatasourceType>('postgresql')
  const [form, setForm] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  /** 打开对话框时按编辑目标初始化表单（由 open 变更事件驱动，避免 effect 内同步 setState） */
  const initForm = () => {
    const t = (editing?.type ?? 'postgresql') as DatasourceType
    setName(editing?.name ?? '')
    setType(t)
    if (editing) {
      const init: Record<string, string> = {}
      for (const f of CONFIG_FIELDS[t]) {
        const v = editing.config?.[f.name]
        init[f.name] = v === undefined || v === null ? '' : String(v)
      }
      setForm(init)
    } else {
      setForm(defaultsFor(t))
    }
    setError('')
    setTestResult(null)
  }

  const setField = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const changeType = (value: DatasourceType | null) => {
    const next = value ?? 'postgresql'
    setType(next)
    setForm(defaultsFor(next))
    setError('')
    setTestResult(null)
  }

  /** 组装 config 载荷：密码留空不提交（保留旧密文），掩码原样提交由后端保留 */
  const buildConfig = (): Record<string, unknown> => {
    const payload: Record<string, unknown> = {}
    for (const f of CONFIG_FIELDS[type]) {
      const raw = (form[f.name] ?? '').trim()
      if (f.type === 'select') {
        payload[f.name] = raw === 'true'
      } else if (f.type === 'number') {
        if (raw !== '') payload[f.name] = Number(raw)
      } else if (f.type === 'password') {
        if (raw !== '') payload[f.name] = raw
      } else {
        payload[f.name] = raw
      }
    }
    return payload
  }

  const testConnection = async () => {
    setTesting(true)
    setError('')
    setTestResult(null)
    try {
      const r = await api.post<TestResult>('/datasources/test', { type, config: buildConfig() })
      setTestResult(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : '连接测试失败')
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    if (type === 'sqlite' && !(form.path ?? '').trim()) {
      setError('SQLite 需要填写文件路径')
      return
    }
    setSaving(true)
    setError('')
    try {
      if (editing) {
        await api.post('/datasources/update', { id: editing.id, name: name.trim(), type, config: buildConfig() })
      } else {
        await api.post('/datasources', { name: name.trim(), type, config: buildConfig() })
      }
      onSaved()
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const isFile = FILE_TYPES.includes(type)

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen) initForm()
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑数据源' : '新建数据源'}</DialogTitle>
          <DialogDescription>
            敏感字段（密码等）加密存储；编辑时密码留空或保持掩码则不修改旧值。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isFile && (
            <p className="rounded-md bg-warning-bg px-3 py-2 text-xs text-warning">
              「{datasourceTypeLabel(type)}」为文件型数据源，请通过聊天区附件上传导入，暂不支持在此保存连接配置。
            </p>
          )}

          <div className="space-y-1.5">
            <Label>名称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：生产库" />
          </div>

          <div className="space-y-1.5">
            <Label>类型</Label>
            <Select
              value={type}
              items={Object.fromEntries(DATASOURCE_TYPE_OPTIONS.map((o) => [o.value, o.label]))}
              onValueChange={changeType}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DATASOURCE_TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {!isFile && <DataSourceConfigFields type={type} form={form} onFieldChange={setField} />}

          <DataSourceFormFooter
            error={error}
            testResult={testResult}
            testing={testing}
            saving={saving}
            disabled={isFile || !name.trim()}
            onTest={() => void testConnection()}
            onSave={() => void save()}
            onCancel={() => onOpenChange(false)}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
