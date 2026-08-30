import { useEffect, useState } from 'react'
import { Activity, Coins, Gauge, Timer } from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from 'recharts'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { cn } from '@/lib/utils'
import type { TokenStats } from '@/types/analytics'

const RANGE_OPTIONS = [
  { label: '近 7 天', value: 7 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 },
]

/** 汇总卡：图标 + 数值 + 说明 */
function SummaryCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Coins
  label: string
  value: string
  hint: string
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground">
        <Icon size={16} />
      </div>
      <div className="min-w-0">
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="truncate text-lg font-semibold tabular-nums text-foreground">{value}</div>
        <div className="text-[11px] text-muted-foreground">{hint}</div>
      </div>
    </div>
  )
}

const chartConfig = {
  tokens: { label: 'Token 消耗', color: 'var(--chart-1)' },
} satisfies ChartConfig

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`
  return n.toLocaleString('zh-CN')
}

/** Token 用量统计页：汇总卡 + 按日消耗曲线（area）+ 按模型分布表。 */
export function StatsPage() {
  const [days, setDays] = useState(30)
  const [reloadKey, setReloadKey] = useState(0)
  const [data, setData] = useState<TokenStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    void api
      .get<TokenStats>(`/stats/tokens?days=${days}`)
      .then((res) => {
        if (!alive) return
        setData(res)
        setError('')
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : '用量统计加载失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [days, reloadKey])

  const daily = data?.daily ?? []
  const summary = data?.summary

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-6 pb-1 pt-6">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground">用量统计</h2>
          <p className="text-xs text-muted-foreground">LLM Token 消耗与调用情况（按 AI 类日志聚合）</p>
        </div>
        <div className="flex gap-1" role="group" aria-label="统计范围">
          {RANGE_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              variant={days === opt.value ? 'default' : 'outline'}
              size="sm"
              onClick={() => setDays(opt.value)}
              aria-pressed={days === opt.value}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 px-6 pb-6 pt-4">
        {error && (
          <div className="flex items-center justify-between rounded-lg border border-error/30 bg-error-bg px-4 py-3">
            <p className="text-xs text-error">{error}</p>
            <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
              重试
            </Button>
          </div>
        )}

        {(loading || !summary) && !error && (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-[72px] w-full" />
              ))}
            </div>
            <Skeleton className="h-64 w-full" />
          </div>
        )}

        {summary && !loading && (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              <SummaryCard
                icon={Coins}
                label="Token 总消耗"
                value={formatTokens(summary.total_tokens)}
                hint={`近 ${data?.days ?? days} 天累计`}
              />
              <SummaryCard
                icon={Activity}
                label="调用次数"
                value={summary.total_calls.toLocaleString('zh-CN')}
                hint={`日均 ${summary.total_calls ? Math.round(summary.total_calls / (data?.days ?? days)) : 0} 次`}
              />
              <SummaryCard
                icon={Timer}
                label="平均响应延迟"
                value={`${summary.avg_latency_ms} ms`}
                hint="单次对话端到端均值"
              />
            </div>

            <div className="rounded-lg border bg-card p-4">
              <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-foreground">
                <Gauge size={14} className="text-muted-foreground" />
                每日 Token 消耗
              </div>
              {daily.length === 0 ? (
                <div className="flex h-56 items-center justify-center text-[13px] text-muted-foreground">
                  暂无数据
                </div>
              ) : (
                <ChartContainer config={chartConfig} className="aspect-auto h-56 w-full">
                  <AreaChart data={daily} accessibilityLayer margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
                    <defs>
                      <linearGradient id="tokenAreaGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickLine={false}
                      axisLine={false}
                      tick={{ fontSize: 9 }}
                      dy={6}
                      tickFormatter={(v: string) => {
                        // 按「月-日」展示日期刻度，避免硬编码截断导致的时区/格式问题
                        const parts = v.split('-')
                        return parts.length >= 3 ? `${parts[1]}/${parts[2]}` : v
                      }}
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      tick={{ fontSize: 9 }}
                      width={48}
                      tickFormatter={(v: number) => formatTokens(v)}
                    />
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          indicator="dot"
                          labelFormatter={(label) => String(label)}
                          formatter={(value, name) => (
                            <div className="flex w-full items-center justify-between gap-3">
                              <span className="text-muted-foreground">
                                {name === 'tokens' ? 'Token 消耗' : name}
                              </span>
                              <span className="font-mono font-medium text-foreground">
                                {Number(value).toLocaleString('zh-CN')}
                              </span>
                            </div>
                          )}
                        />
                      }
                    />
                    <Area
                      type="monotone"
                      dataKey="tokens"
                      stroke="var(--chart-1)"
                      strokeWidth={2}
                      fill="url(#tokenAreaGrad)"
                    />
                  </AreaChart>
                </ChartContainer>
              )}
            </div>

            <div className="overflow-hidden rounded-lg border bg-card">
              <div className="border-b px-4 py-3 text-[13px] font-semibold text-foreground">按模型分布</div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">模型</th>
                    <th className="px-4 py-2.5 font-medium">Token 消耗</th>
                    <th className="px-4 py-2.5 font-medium">调用次数</th>
                    <th className="px-4 py-2.5 font-medium">平均延迟</th>
                    <th className="px-4 py-2.5 font-medium">占比</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.models ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                        暂无调用记录
                      </td>
                    </tr>
                  )}
                  {(data?.models ?? []).map((m) => (
                    <tr key={m.model} className="border-t hover:bg-muted/50">
                      <td className="px-4 py-2.5 font-medium text-foreground">{m.model}</td>
                      <td className="px-4 py-2.5 tabular-nums text-foreground">
                        {m.tokens.toLocaleString('zh-CN')}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{m.calls}</td>
                      <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{m.avg_latency_ms} ms</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                            <div
                              className={cn('h-full rounded-full bg-primary')}
                              style={{
                                width: `${summary.total_tokens ? Math.min(100, (m.tokens / summary.total_tokens) * 100) : 0}%`,
                              }}
                            />
                          </div>
                          <span className="tabular-nums text-muted-foreground">
                            {summary.total_tokens ? ((m.tokens / summary.total_tokens) * 100).toFixed(1) : '0.0'}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
