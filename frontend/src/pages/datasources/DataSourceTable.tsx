import { Button } from '@/components/ui/button'
import type { DataSourceInfo } from '@/store/dataSourceStore'
import { datasourceTypeLabel, isFileType, type TestResult } from './constants'

export type TestState = TestResult | 'loading'

interface Props {
  list: DataSourceInfo[]
  testMap: Record<string, TestState>
  onTest: (ds: DataSourceInfo) => void
  onPreview: (ds: DataSourceInfo) => void
  onSchema: (ds: DataSourceInfo) => void
  onPrompts: (ds: DataSourceInfo) => void
  onEdit: (ds: DataSourceInfo) => void
  onDelete: (ds: DataSourceInfo) => void
}

function formatTime(value?: string | null): string {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 连接状态徽标：ok=正常 / error=异常（悬浮失败原因）/ unknown=未检测；文件型无连接概念。 */
function StatusCell({ ds }: { ds: DataSourceInfo }) {
  if (isFileType(ds.type)) {
    return <span className="text-muted-foreground">—</span>
  }
  const status = ds.status ?? 'unknown'
  const label = status === 'ok' ? '正常' : status === 'error' ? '异常' : '未检测'
  const tip =
    status === 'error'
      ? `最近失败原因：${ds.last_error || '未知'}${ds.server_version ? `\n版本：${ds.server_version}` : ''}`
      : ds.server_version
        ? `服务器版本：${ds.server_version}`
        : undefined
  return (
    <div className="flex flex-col gap-0.5" title={tip}>
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={`status-dot ${status === 'ok' ? 'succeeded' : status === 'error' ? 'failed' : 'queued'}`}
        />
        <span className={status === 'ok' ? 'text-success' : status === 'error' ? 'text-error' : 'text-muted-foreground'}>
          {label}
        </span>
      </span>
      <span className="text-[11px] text-muted-foreground">
        {ds.last_checked_at ? `检测于 ${formatTime(ds.last_checked_at)}` : '从未检测'}
      </span>
    </div>
  )
}

/** 数据源列表表格：名称 / 类型 badge / 连接状态 / 更新时间 / 操作（测试、预览、Schema、文案、编辑、删除）。 */
export function DataSourceTable({
  list,
  testMap,
  onTest,
  onPreview,
  onSchema,
  onPrompts,
  onEdit,
  onDelete,
}: Props) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2.5 font-medium">名称</th>
            <th className="px-4 py-2.5 font-medium">类型</th>
            <th className="px-4 py-2.5 font-medium">连接状态</th>
            <th className="px-4 py-2.5 font-medium">更新时间</th>
            <th className="px-4 py-2.5 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {list.map((ds) => {
            const testState = testMap[ds.id]
            return (
              <tr key={ds.id} className="border-t hover:bg-muted/50">
                <td className="px-4 py-2.5 font-medium text-foreground">
                  <span className="block max-w-[220px] truncate" title={ds.name}>
                    {ds.name}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span className={`badge ${isFileType(ds.type) ? 'badge-outline' : 'badge-secondary'}`}>
                    {datasourceTypeLabel(ds.type)}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <StatusCell ds={ds} />
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{formatTime(ds.updated_at)}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-end gap-1">
                    {testState === 'loading' && <span className="mr-1 text-[11px] text-info">测试中…</span>}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onTest(ds)}
                      disabled={testState === 'loading'}
                    >
                      测试
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => onPreview(ds)}>
                      预览
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => onSchema(ds)}>
                      Schema
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => onPrompts(ds)}>
                      文案{ds.quick_prompts?.length ? `(${ds.quick_prompts.length})` : ''}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => onEdit(ds)}>
                      编辑
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => onDelete(ds)}>
                      删除
                    </Button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
