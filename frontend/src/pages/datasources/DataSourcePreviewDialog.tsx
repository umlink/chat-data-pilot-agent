import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import type { DataSourceInfo } from '@/store/dataSourceStore'

interface PreviewData {
  table_schema: string
  table: string
  columns: Array<{ name: string; data_type: string }>
  rows: Array<Record<string, unknown>>
  count: number
  truncated: boolean
}

interface Props {
  /** 预览目标；null 时关闭 */
  ds: DataSourceInfo | null
  onClose: () => void
}

const PREVIEW_LIMIT = 50

function cell(v: unknown): string {
  return v === null || v === undefined ? '-' : String(v)
}

/** 数据预览 Dialog：表格前 50 行 + 列头类型 + 行数/截断提示。 */
export function DataSourcePreviewDialog({ ds, onClose }: Props) {
  const [data, setData] = useState<PreviewData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!ds) return
    let alive = true
    void api
      .get<PreviewData>(`/datasources/${ds.id}/preview?limit=${PREVIEW_LIMIT}`)
      .then((d) => {
        if (alive) setData(d)
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : '预览失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [ds])

  return (
    <Dialog
      open={ds !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      onOpenChangeComplete={(isOpen) => {
        // 打开时重置（由事件驱动，effect 内只做异步拉取）
        if (isOpen) {
          setLoading(true)
          setError('')
          setData(null)
        }
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>预览：{ds?.name ?? ''}</DialogTitle>
          <DialogDescription>
            {data
              ? `${data.table_schema}.${data.table} · 共 ${data.count} 行${
                  data.truncated ? `（已截断，仅显示前 ${PREVIEW_LIMIT} 行）` : ''
                }`
              : '加载中…'}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="space-y-2">
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-full" />
          </div>
        )}
        {error && <p className="rounded-md bg-error-bg px-3 py-2 text-xs text-error">{error}</p>}
        {!loading && !error && data && data.rows.length === 0 && (
          <p className="py-10 text-center text-xs text-muted-foreground">该表暂无数据</p>
        )}
        {!loading && !error && data && data.rows.length > 0 && (
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-muted">
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  {data.columns.map((c) => (
                    <th key={c.name} className="whitespace-nowrap px-3 py-2 font-medium">
                      {c.name}
                      <span className="ml-1 font-normal normal-case text-muted-foreground/70">
                        {c.data_type}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, i) => (
                  <tr key={i} className="border-t">
                    {data.columns.map((c) => (
                      <td
                        key={c.name}
                        className="max-w-[240px] truncate whitespace-nowrap px-3 py-1.5"
                        title={cell(row[c.name])}
                      >
                        {cell(row[c.name])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
