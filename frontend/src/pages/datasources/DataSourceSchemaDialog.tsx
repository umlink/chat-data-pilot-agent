import { useEffect, useState } from 'react'
import { Table2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import type { DataSourceInfo } from '@/store/dataSourceStore'

/** 数据源 Schema 出参（镜像 backend/app/services/data_service.py get_schema）。 */
interface SchemaColumn {
  name: string
  data_type: string
  comment?: string | null
  is_nullable?: boolean
}
interface SchemaTable {
  schema: string
  name: string
  comment?: string | null
  columns: SchemaColumn[]
  sample?: Record<string, unknown>[] | null
}
interface DataSourceSchema {
  datasource_id: string
  datasource_type: string
  tables: SchemaTable[]
}

/** 采样行紧凑表格：优先按列顺序展示，缺列名时回退为对象键顺序 */
function SampleTable({ sample, columns }: { sample: Record<string, unknown>[]; columns: SchemaColumn[] }) {
  const first = sample[0] ?? {}
  const keys = columns.map((c) => c.name).filter((k) => k in first)
  const showKeys = keys.length > 0 ? keys : Object.keys(first)
  return (
    <div className="mt-1 overflow-x-auto rounded-md border">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="bg-muted/50 text-left text-muted-foreground">
            {showKeys.map((k) => (
              <th key={k} className="px-2 py-1 font-medium">
                {k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sample.map((row, ri) => (
            <tr key={ri} className="border-t">
              {showKeys.map((k) => (
                <td key={k} className="px-2 py-1 text-foreground">
                  {String(row[k] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 数据源 Schema 查看 Dialog：左侧表清单，右侧列结构 + 注释 + 采样行。 */
export function DataSourceSchemaDialog({ ds, onClose }: { ds: DataSourceInfo | null; onClose: () => void }) {
  const [schema, setSchema] = useState<DataSourceSchema | null>(null)
  const [selected, setSelected] = useState<SchemaTable | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!ds) return
    let alive = true
    void api
      .get<DataSourceSchema>(`/datasources/${ds.id}/schema`)
      .then((d) => {
        if (!alive) return
        setSchema(d)
        if (d.tables.length > 0) setSelected(d.tables[0])
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Schema 加载失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [ds])

  const tables = schema?.tables ?? []

  return (
    <Dialog
      open={ds !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      onOpenChangeComplete={(isOpen) => {
        // 打开时重置（事件驱动，effect 内只做异步拉取）
        if (isOpen) {
          setLoading(true)
          setError('')
          setSchema(null)
          setSelected(null)
        }
      }}
    >
      <DialogContent className="flex h-[80vh] max-w-4xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-3">
          <DialogTitle>Schema：{ds?.name ?? ''}</DialogTitle>
          <DialogDescription>
            {ds ? `${ds.type} · 表清单 / 列结构 / 注释 / 采样行` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1">
          <aside className="w-60 shrink-0 overflow-y-auto border-r p-2">
            {loading &&
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="mb-1.5 h-7 w-full" />)}
            {!loading && error && <p className="p-2 text-xs text-error">{error}</p>}
            {!loading && !error &&
              tables.map((t) => {
                const key = `${t.schema}.${t.name}`
                const active = selected === t
                return (
                  <button
                    key={key}
                    onClick={() => setSelected(t)}
                    className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] ${
                      active
                        ? 'bg-accent font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-muted/50'
                    }`}
                  >
                    <Table2 size={13} className="shrink-0" />
                    <span className="flex-1 truncate">{t.name}</span>
                    <span className="text-[11px] text-muted-foreground">{t.columns.length}</span>
                  </button>
                )
              })}
            {!loading && !error && tables.length === 0 && (
              <p className="p-2 text-xs text-muted-foreground">数据库中暂无可展示的表</p>
            )}
          </aside>
          <section className="min-w-0 flex-1 overflow-y-auto p-4">
            {selected ? (
              <div>
                <h3 className="text-sm font-semibold text-foreground">{selected.name}</h3>
                {selected.comment ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">{selected.comment}</p>
                ) : null}
                <table className="mt-3 w-full text-xs">
                  <thead>
                    <tr className="bg-muted text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-1.5 font-medium">列</th>
                      <th className="px-3 py-1.5 font-medium">类型</th>
                      <th className="px-3 py-1.5 font-medium">可空</th>
                      <th className="px-3 py-1.5 font-medium">注释</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.columns.map((c) => (
                      <tr key={c.name} className="border-t">
                        <td className="px-3 py-1.5 font-mono text-foreground">{c.name}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">{c.data_type}</td>
                        <td className="px-3 py-1.5">{c.is_nullable === false ? 'NO' : 'YES'}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">{c.comment || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {selected.sample && selected.sample.length > 0 ? (
                  <div className="mt-4">
                    <p className="text-[11px] font-medium text-muted-foreground">采样数据（前 3 行）</p>
                    <SampleTable sample={selected.sample} columns={selected.columns} />
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="p-4 text-xs text-muted-foreground">选择左侧表查看结构</p>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
