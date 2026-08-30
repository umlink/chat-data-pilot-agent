import { useCallback, useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { api, downloadFile } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { LogsPage as LogsPageResult } from '@/types/config'
import { LogsFilter } from './LogsFilter'
import { LogsPagination } from './LogsPagination'
import { LogsTable } from './LogsTable'

function exportFilename(): string {
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `logs_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.csv`
}

/** 日志查看页：筛选（分类/级别/关键词/时间范围）+ 分页表格 + CSV 导出。 */
export function LogsPage() {
  const [category, setCategory] = useState('')
  const [level, setLevel] = useState('')
  const [keyword, setKeyword] = useState('')
  const [debouncedKeyword, setDebouncedKeyword] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [reloadKey, setReloadKey] = useState(0)
  const [data, setData] = useState<LogsPageResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)

  // 关键词 400ms 防抖；变更后回到第一页
  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedKeyword(keyword)
      setPage(1)
    }, 400)
    return () => window.clearTimeout(t)
  }, [keyword])

  /** 组装过滤 query（空值不传；datetime-local 本地时间 → ISO8601 UTC） */
  const buildQuery = useCallback(() => {
    const q: Record<string, string> = {}
    if (category) q.category = category
    if (level) q.level = level
    const k = debouncedKeyword.trim()
    if (k) q.keyword = k
    if (start) q.start = new Date(start).toISOString()
    if (end) q.end = new Date(end).toISOString()
    return q
  }, [category, level, debouncedKeyword, start, end])

  // 挂载与筛选/分页变化时拉取（effect 内只做异步回调 setState，loading 初始为 true）
  useEffect(() => {
    let alive = true
    const q = buildQuery()
    const qs = new URLSearchParams(q).toString()
    void api
      .get<LogsPageResult>(`/logs?${qs}&page=${page}&page_size=${pageSize}`)
      .then((res) => {
        if (alive) setData(res)
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : '日志加载失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [buildQuery, page, pageSize, reloadKey])

  const reset = () => {
    setCategory('')
    setLevel('')
    setKeyword('')
    setDebouncedKeyword('')
    setStart('')
    setEnd('')
    setPage(1)
  }

  const exportCsv = async () => {
    setExporting(true)
    try {
      // 导出全部匹配（不分页），POST + query 文件流
      await downloadFile('/logs/export', exportFilename(), { query: buildQuery() })
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-6 pb-1 pt-6">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground">日志查看</h2>
          <p className="text-xs text-muted-foreground">系统 / 应用 / AI / 错误 / 审计日志，支持筛选、分页与 CSV 导出</p>
        </div>
        <Button size="lg" variant="outline" onClick={() => void exportCsv()} disabled={exporting}>
          <Download /> {exporting ? '导出中…' : '导出 CSV'}
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 px-6 pb-6 pt-4">
        <LogsFilter
          category={category}
          level={level}
          keyword={keyword}
          start={start}
          end={end}
          onCategoryChange={(v) => {
            setCategory(v)
            setPage(1)
          }}
          onLevelChange={(v) => {
            setLevel(v)
            setPage(1)
          }}
          onKeywordChange={setKeyword}
          onStartChange={(v) => {
            setStart(v)
            setPage(1)
          }}
          onEndChange={(v) => {
            setEnd(v)
            setPage(1)
          }}
          onReset={reset}
        />

        {error && (
          <div className="flex items-center justify-between rounded-lg border border-error/30 bg-error-bg px-4 py-3">
            <p className="text-xs text-error">{error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLoading(true)
                setReloadKey((k) => k + 1)
              }}
            >
              重试
            </Button>
          </div>
        )}

        {loading && data === null && (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        )}

        {data !== null && <LogsTable items={data.items} />}

        {data !== null && data.items.length > 0 && (
          <LogsPagination
            total={data.total}
            page={data.page}
            pageSize={pageSize}
            loading={loading}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size)
              setPage(1)
            }}
          />
        )}
      </div>
    </div>
  )
}
