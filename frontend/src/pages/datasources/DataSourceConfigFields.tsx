import { useId } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CONFIG_FIELDS, type DatasourceType } from './constants'
import { MaskedInput } from '@/components/common/MaskedInput'

interface Props {
  type: DatasourceType
  form: Record<string, string>
  onFieldChange: (key: string, value: string) => void
}

/** 按数据源类型动态渲染连接配置字段（镜像 backend/app/schemas/datasource.py 字段集合）。 */
export function DataSourceConfigFields({ type, form, onFieldChange }: Props) {
  const idBase = useId()
  return (
    <>
      {CONFIG_FIELDS[type].map((f) => {
        const fieldId = `${idBase}-${f.name}`
        return (
          <div key={f.name} className="space-y-1.5">
            <Label htmlFor={f.type === 'password' ? undefined : fieldId}>
              {f.label}
              {f.required ? ' *' : ''}
            </Label>
            {f.type === 'select' ? (
              <Select
                value={form[f.name] ?? ''}
                items={Object.fromEntries((f.options ?? []).map((o) => [o.value, o.label]))}
                onValueChange={(v) => onFieldChange(f.name, String(v ?? ''))}
              >
                <SelectTrigger id={fieldId} className="w-full">
                  <SelectValue placeholder="请选择" />
                </SelectTrigger>
                <SelectContent>
                  {f.options?.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : f.type === 'password' ? (
              <MaskedInput value={form[f.name] ?? ''} onChange={(v) => onFieldChange(f.name, v)} />
            ) : (
              <Input
                id={fieldId}
                name={f.name}
                type={f.type === 'number' ? 'number' : 'text'}
                value={form[f.name] ?? ''}
                onChange={(e) => onFieldChange(f.name, e.target.value)}
                placeholder={f.placeholder}
                autoComplete="off"
              />
            )}
          </div>
        )
      })}
    </>
  )
}
