import { useMemo, useRef, useState } from 'react'
import { Maximize2, Settings2, Star } from 'lucide-react'
import { api } from '@/lib/api'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
} from 'recharts'
import type { ChartContent, ChartSeries } from '@/types/message'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { SqlQueryDialog } from './SqlQueryDialog'

interface Props {
  content: ChartContent
  /** 展示「收藏到看板」按钮（对话中的图表可收藏；看板页自身不重复收藏） */
  savable?: boolean
  /** 溯源会话 ID（收藏快照关联会话；会话删除后快照保留） */
  sessionId?: string
}

// 图表主色固定取语义 token（docs/UI设计规范.md 1.1 chart-1..5 橙色阶）
const TOKENS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
]

/** 本地图表配置覆盖（chart 契约 6.2 为终态无更新字段，仅展示层生效，不写回） */
interface ChartSettings {
  title?: string
  x_label?: string
  y_label?: string
  /** 仅存被用户修改的系列色，未覆盖的系列回落默认 token */
  seriesColors: string[]
}

const DEFAULT_SETTINGS: ChartSettings = { seriesColors: [] }

/** 系列扁平化为 recharts 行：[{ x, [seriesName]: y }] */
function toRows(series: ChartSeries[]): Record<string, string | number>[] {
  const cats = series[0]?.x ?? []
  return cats.map((cat, i) => {
    const row: Record<string, string | number> = { x: cat }
    for (const s of series) row[s.name] = s.y[i] ?? 0
    return row
  })
}

/** 系列名 → config（供 tooltip/legend 展示中文标签） */
function buildConfig(series: ChartSeries[]): ChartConfig {
  const cfg: ChartConfig = {}
  for (const s of series) cfg[s.name] = { label: s.name }
  return cfg
}

/** 按配置覆盖解析每系列最终颜色 */
function resolveColors(series: ChartSeries[], colors: string[]): string[] {
  return series.map((_, i) => colors[i] ?? TOKENS[i % TOKENS.length])
}

/** 柱状主色渐变橙 400→600（docs/UI设计规范.md 3.7） */
const BAR_GRADIENT_ID = 'dpChartBarGrad'

function BarPanel({
  content,
  colors,
  chartClass = 'aspect-auto h-56 w-full',
}: {
  content: ChartContent
  colors: string[]
  chartClass?: string
}) {
  const { series, x_label, y_label } = content
  const rows = toRows(series)
  const single = series.length === 1
  const gradFrom = colors[0] ?? 'var(--chart-2)'
  const gradTo = colors[Math.min(1, colors.length - 1)] ?? 'var(--chart-3)'
  return (
    <ChartContainer config={buildConfig(series)} className={chartClass}>
      <BarChart data={rows} accessibilityLayer margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
        <defs>
          <linearGradient id={BAR_GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={gradFrom} />
            <stop offset="100%" stopColor={gradTo} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="x"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 9 }}
          dy={6}
          label={x_label ? { value: x_label, position: 'insideBottom', offset: -1, fontSize: 9 } : undefined}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 9 }}
          width={34}
          label={y_label ? { value: y_label, angle: -90, position: 'insideLeft', fontSize: 9 } : undefined}
        />
        <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
        {single ? (
          <Bar dataKey={series[0].name} fill={`url(#${BAR_GRADIENT_ID})`} radius={[4, 4, 0, 0]} />
        ) : (
          series.map((s, i) => (
            <Bar key={s.name} dataKey={s.name} fill={colors[i % colors.length]} radius={[4, 4, 0, 0]} />
          ))
        )}
        {series.length >= 2 && <ChartLegend content={<ChartLegendContent />} />}
      </BarChart>
    </ChartContainer>
  )
}

function LinePanel({
  content,
  colors,
  chartClass = 'aspect-auto h-56 w-full',
}: {
  content: ChartContent
  colors: string[]
  chartClass?: string
}) {
  const { series, x_label, y_label } = content
  return (
    <ChartContainer config={buildConfig(series)} className={chartClass}>
      <LineChart data={toRows(series)} accessibilityLayer margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="x"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 9 }}
          dy={6}
          label={x_label ? { value: x_label, position: 'insideBottom', offset: -1, fontSize: 9 } : undefined}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 9 }}
          width={34}
          label={y_label ? { value: y_label, angle: -90, position: 'insideLeft', fontSize: 9 } : undefined}
        />
        <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
        {series.map((s, i) => (
          <Line
            key={s.name}
            type="monotone"
            dataKey={s.name}
            stroke={colors[i % colors.length]}
            strokeWidth={2}
            dot={{ r: 3, strokeWidth: 0 }}
            activeDot={{ r: 5 }}
          />
        ))}
        {series.length >= 2 && <ChartLegend content={<ChartLegendContent />} />}
      </LineChart>
    </ChartContainer>
  )
}

function PiePanel({
  content,
  colors,
  chartClass = 'aspect-auto h-56 w-full',
}: {
  content: ChartContent
  colors: string[]
  chartClass?: string
}) {
  const s = content.series[0]
  if (!s) {
    return <div className="py-10 text-center text-[13px] text-muted-foreground">暂无图表数据</div>
  }
  const data = s.x.map((cat, i) => ({ x: cat, value: s.y[i] ?? 0 }))
  return (
    <ChartContainer config={buildConfig([s])} className={chartClass}>
      <PieChart accessibilityLayer>
        <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
        <Pie data={data} dataKey="value" nameKey="x" innerRadius={48} outerRadius={76} paddingAngle={2} strokeWidth={0}>
          {data.map((_, i) => (
            <Cell key={i} fill={colors[i % colors.length]} />
          ))}
        </Pie>
        <ChartLegend content={<ChartLegendContent />} />
      </PieChart>
    </ChartContainer>
  )
}

function ScatterPanel({
  content,
  colors,
  chartClass = 'aspect-auto h-56 w-full',
}: {
  content: ChartContent
  colors: string[]
  chartClass?: string
}) {
  const { series, x_label } = content
  return (
    <ChartContainer config={buildConfig(series)} className={chartClass}>
      <ScatterChart accessibilityLayer margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          type="number"
          dataKey="x"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 9 }}
          dy={6}
          label={x_label ? { value: x_label, position: 'insideBottom', offset: -1, fontSize: 9 } : undefined}
        />
        <YAxis type="number" tickLine={false} axisLine={false} tick={{ fontSize: 9 }} width={34} />
        <ChartTooltip content={<ChartTooltipContent indicator="dot" />} cursor={{ strokeDasharray: '3 3' }} />
        {series.map((s, i) => (
          <Scatter key={s.name} name={s.name} data={toRows(series)} dataKey={s.name} fill={colors[i % colors.length]} />
        ))}
        {series.length >= 2 && <ChartLegend content={<ChartLegendContent />} />}
      </ScatterChart>
    </ChartContainer>
  )
}

/** 热力图：recharts 无原生支持，用 SVG rect 网格渲染（保持与导出管道同源） */
const HEAT_CELL = 26
const HEAT_X_LABEL_H = 20

function heatColor(value: number, min: number, max: number): string {
  if (max <= min) return TOKENS[2]
  const t = Math.min(1, Math.max(0, (value - min) / (max - min)))
  return TOKENS[Math.min(TOKENS.length - 1, Math.floor(t * TOKENS.length))]
}

function HeatmapPanel({ content }: { content: ChartContent }) {
  const matrix = content.matrix
  const matrixValid =
    !!matrix &&
    matrix.values.length > 0 &&
    matrix.values[0].length > 0 &&
    matrix.x_categories.length > 0 &&
    matrix.y_categories.length > 0
  if (!matrixValid || !matrix) {
    return <div className="py-10 text-center text-[13px] text-muted-foreground">暂无热力图数据</div>
  }
  const { x_categories, y_categories, values } = matrix
  const cols = x_categories.length
  const rows = y_categories.length
  const flat = values.flat().filter((v) => Number.isFinite(v))
  const min = flat.length ? Math.min(...flat) : 0
  const max = flat.length ? Math.max(...flat) : 0
  // 左轴标签区按最长 y 标签自适应（上限 96px），超出 12 字符截断
  const yLabelW = Math.min(96, Math.max(24, ...y_categories.map((c) => c.length * 7)) + 10)
  const width = yLabelW + cols * HEAT_CELL
  const height = HEAT_X_LABEL_H + rows * HEAT_CELL
  const truncate = (s: string, max = 7) => (s.length > max ? `${s.slice(0, max)}…` : s)
  return (
    <div className="w-full">
      <div className="overflow-x-auto">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={content.title || '热力图'}
          className="block"
        >
          {/* Y 轴类别标签 */}
          {y_categories.map((label, r) => (
            <text
              key={`y-${r}`}
              x={yLabelW - 6}
              y={r * HEAT_CELL + HEAT_CELL / 2}
              textAnchor="end"
              dominantBaseline="central"
              fontSize={9}
              fill="var(--muted-foreground)"
            >
              {truncate(label)}
            </text>
          ))}
          {/* 值网格 */}
          {values.map((row, r) =>
            row.map((v, c) => (
              <rect
                key={`${r}-${c}`}
                x={yLabelW + c * HEAT_CELL + 1}
                y={r * HEAT_CELL + 1}
                width={HEAT_CELL - 2}
                height={HEAT_CELL - 2}
                rx={2}
                fill={heatColor(v, min, max)}
              >
                <title>{`${y_categories[r] ?? ''} × ${x_categories[c] ?? ''}：${v}`}</title>
              </rect>
            )),
          )}
          {/* X 轴类别标签 */}
          {x_categories.map((label, c) => (
            <text
              key={`x-${c}`}
              x={yLabelW + c * HEAT_CELL + HEAT_CELL / 2}
              y={height - 6}
              textAnchor="middle"
              fontSize={9}
              fill="var(--muted-foreground)"
            >
              {truncate(label)}
            </text>
          ))}
        </svg>
      </div>
      {/* 色阶图例（低 → 高） */}
      <div className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <span>低</span>
        {TOKENS.map((t) => (
          <span key={t} className="size-3 rounded-sm" style={{ background: t }} />
        ))}
        <span>高</span>
        <span className="ml-2">
          {Number.isFinite(min) ? min : 0} ~ {Number.isFinite(max) ? max : 0}
        </span>
      </div>
    </div>
  )
}

/** 按 chart_type 渲染图表面板（卡片与全屏共用；chartClass 控制高度/宽度）。 */
function ChartPanel({
  content,
  colors,
  chartClass,
}: {
  content: ChartContent
  colors: string[]
  chartClass?: string
}) {
  switch (content.chart_type) {
    case 'bar':
      return <BarPanel content={content} colors={colors} chartClass={chartClass} />
    case 'line':
      return <LinePanel content={content} colors={colors} chartClass={chartClass} />
    case 'pie':
      return <PiePanel content={content} colors={colors} chartClass={chartClass} />
    case 'scatter':
      return <ScatterPanel content={content} colors={colors} chartClass={chartClass} />
    case 'heatmap':
      return <HeatmapPanel content={content} />
    default:
      return <div className="py-10 text-center text-[13px] text-muted-foreground">暂不支持该图表类型</div>
  }
}

/** 图表全屏查看 Dialog：大尺寸渲染 + 导出/设置/查看 SQL（导出基于大图自身 ref）。 */
function ChartFullscreenDialog({
  content,
  colors,
  open,
  onOpenChange,
  onOpenSettings,
  onOpenSql,
  showSql,
}: {
  content: ChartContent
  colors: string[]
  open: boolean
  onOpenChange: (v: boolean) => void
  onOpenSettings: () => void
  onOpenSql: () => void
  showSql: boolean
}) {
  const chartRef = useRef<HTMLDivElement>(null)
  const title = content.title || '图表'
  const { downloadSvg, downloadPng, downloadPdf } = useChartExport(chartRef, title)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex flex-col gap-0 p-0"
        style={{ width: '92vw', height: '92vh', maxWidth: '92vw' }}
      >
        <DialogHeader className="flex shrink-0 flex-row items-center justify-between gap-2 border-b px-5 py-3">
          <DialogTitle className="truncate text-sm">{title}</DialogTitle>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={onOpenSettings}
              className="rounded bg-background/80 px-1.5 py-1 text-muted-foreground hover:text-foreground"
              title="图表设置"
              aria-label="图表设置"
            >
              <Settings2 className="size-3.5" />
            </button>
            {showSql && (
              <button
                onClick={onOpenSql}
                className="rounded bg-background/80 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                title="查看查询 SQL"
                aria-label="查看查询 SQL"
              >
                SQL
              </button>
            )}
            <button
              onClick={() => void downloadPng()}
              className="rounded bg-background/80 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
              title="下载 PNG"
              aria-label="导出 PNG"
            >
              PNG
            </button>
            <button
              onClick={downloadSvg}
              className="rounded bg-background/80 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
              title="下载 SVG"
              aria-label="导出 SVG"
            >
              SVG
            </button>
            <button
              onClick={() => void downloadPdf()}
              className="rounded bg-background/80 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
              title="下载 PDF"
              aria-label="导出 PDF"
            >
              PDF
            </button>
          </div>
        </DialogHeader>
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
          <div ref={chartRef} className="flex h-full w-full items-center justify-center">
            <div className="h-full max-h-full w-full">
              <ChartPanel content={content} colors={colors} chartClass="h-full w-full" />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 把图表 SVG 位图化为 canvas（PNG/PDF 共用管道，2x 高清） */
function svgToCanvas(svg: SVGElement, scale = 2): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    const clone = svg.cloneNode(true) as SVGElement
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    const bbox = svg.getBoundingClientRect()
    const w = bbox.width || 800
    const h = bbox.height || 400
    clone.setAttribute('width', String(w))
    clone.setAttribute('height', String(h))
    const svgStr = new XMLSerializer().serializeToString(clone)
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = w * scale
      canvas.height = h * scale
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(url)
        resolve(null)
        return
      }
      ctx.scale(scale, scale)
      // 白底垫底，避免深色模式下导出透明/黑底
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(url)
      resolve(canvas)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}

/** 当前图表导出：SVG 直下 / PNG / PDF（jspdf） */
function useChartExport(chartRef: React.RefObject<HTMLDivElement | null>, title: string) {
  const downloadSvg = () => {
    const svg = chartRef.current?.querySelector('svg')
    if (!svg) return
    const clone = svg.cloneNode(true) as SVGElement
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    const blob = new Blob([clone.outerHTML], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${title}.svg`
    a.click()
    URL.revokeObjectURL(url)
  }

  const downloadPng = async () => {
    const svg = chartRef.current?.querySelector('svg')
    if (!svg) return
    const canvas = await svgToCanvas(svg)
    if (!canvas) return
    canvas.toBlob((pngBlob) => {
      if (!pngBlob) return
      const url = URL.createObjectURL(pngBlob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${title}.png`
      a.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }

  const downloadPdf = async () => {
    const svg = chartRef.current?.querySelector('svg')
    if (!svg) return
    const canvas = await svgToCanvas(svg)
    if (!canvas) return
    // jspdf 体积较大，按需加载（仅首次点击 PDF 时拉取）
    const { jsPDF } = await import('jspdf')
    const bbox = svg.getBoundingClientRect()
    const w = bbox.width || 800
    const h = bbox.height || 400
    const pdf = new jsPDF({
      orientation: w >= h ? 'landscape' : 'portrait',
      unit: 'px',
      format: [w, h],
      compress: true,
    })
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, w, h)
    pdf.save(`${title}.pdf`)
  }

  return { downloadSvg, downloadPng, downloadPdf }
}

/** 图表配置修改弹窗（PRD 3.3.2：颜色/标签/轴/标题，本地展示层生效） */
function ChartSettingsDialog({
  content,
  open,
  onOpenChange,
  settings,
  onApply,
}: {
  content: ChartContent
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: ChartSettings
  onApply: (next: ChartSettings) => void
}) {
  // 打开时从当前生效配置初始化草稿
  const [draft, setDraft] = useState<ChartSettings>(settings)
  const openDialog = (next: boolean) => {
    if (next) setDraft(settings)
    onOpenChange(next)
  }
  const setColor = (index: number, color: string) => {
    const colors = [...draft.seriesColors]
    colors[index] = color
    setDraft({ ...draft, seriesColors: colors })
  }
  const reset = () => {
    setDraft({ ...DEFAULT_SETTINGS })
  }
  return (
    <Dialog open={open} onOpenChange={openDialog}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>图表设置</DialogTitle>
          <DialogDescription>颜色、标签与标题仅影响当前展示，不会改写会话数据。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="chart-title">标题</Label>
            <Input
              id="chart-title"
              value={draft.title ?? ''}
              placeholder={content.title || '默认标题'}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="chart-x-label">X 轴标签</Label>
              <Input
                id="chart-x-label"
                value={draft.x_label ?? ''}
                placeholder={content.x_label || '默认'}
                onChange={(e) => setDraft({ ...draft, x_label: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="chart-y-label">Y 轴标签</Label>
              <Input
                id="chart-y-label"
                value={draft.y_label ?? ''}
                placeholder={content.y_label || '默认'}
                onChange={(e) => setDraft({ ...draft, y_label: e.target.value })}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>系列颜色</Label>
            <div className="grid max-h-40 gap-1.5 overflow-y-auto pr-1">
              {content.series.map((s, i) => {
                const active = draft.seriesColors[i] ?? TOKENS[i % TOKENS.length]
                return (
                  <div key={`${s.name}-${i}`} className="flex items-center gap-2">
                    <span className="w-24 truncate text-muted-foreground">{s.name}</span>
                    <div className="flex gap-1">
                      {TOKENS.map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setColor(i, t)}
                          aria-label={`系列「${s.name}」颜色 ${t}`}
                          aria-pressed={active === t}
                          className={cn(
                            'size-4 cursor-pointer rounded-full transition-transform',
                            active === t ? 'scale-110 ring-2 ring-ring' : 'hover:scale-110',
                          )}
                          style={{ background: t }}
                        />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
        <DialogFooter className="mt-2">
          <Button type="button" variant="ghost" onClick={reset}>
            重置
          </Button>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" onClick={() => onApply(draft)}>
            应用
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ChartToolbar({
  chartRef,
  title,
  onOpenSettings,
  onOpenSql,
  onOpenFullscreen,
  showSql,
  saveState,
  onSave,
}: {
  chartRef: React.RefObject<HTMLDivElement | null>
  title: string
  onOpenSettings: () => void
  onOpenSql: () => void
  onOpenFullscreen: () => void
  showSql: boolean
  saveState?: 'idle' | 'saving' | 'saved' | 'error'
  onSave?: () => void
}) {
  const { downloadSvg, downloadPng, downloadPdf } = useChartExport(chartRef, title)
  return (
    <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      {onSave && (
        <button
          onClick={onSave}
          disabled={saveState !== 'idle'}
          className="rounded bg-background/80 px-1.5 py-1 text-muted-foreground hover:text-foreground disabled:cursor-wait"
          title={
            saveState === 'saved'
              ? '已收藏到看板'
              : saveState === 'error'
                ? '收藏失败，请重试'
                : saveState === 'saving'
                  ? '收藏中…'
                  : '收藏到看板'
          }
          aria-label="收藏到看板"
        >
          <Star
            className={cn(
              'size-3.5',
              saveState === 'saved' && 'fill-warning text-warning',
              saveState === 'error' && 'text-error',
            )}
          />
        </button>
      )}
      <button
        onClick={onOpenFullscreen}
        className="rounded bg-background/80 px-1.5 py-1 text-muted-foreground hover:text-foreground"
        title="全屏查看"
        aria-label="全屏查看"
      >
        <Maximize2 className="size-3.5" />
      </button>
      <button
        onClick={onOpenSettings}
        className="rounded bg-background/80 px-1.5 py-1 text-muted-foreground hover:text-foreground"
        title="图表设置"
        aria-label="图表设置"
      >
        <Settings2 className="size-3.5" />
      </button>
      {showSql && (
        <button
          onClick={onOpenSql}
          className="rounded bg-background/80 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
          title="查看查询 SQL"
          aria-label="查看查询 SQL"
        >
          SQL
        </button>
      )}
      <button
        onClick={() => void downloadPng()}
        className="rounded bg-background/80 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
        title="下载 PNG"
        aria-label="导出 PNG"
      >
        PNG
      </button>
      <button
        onClick={downloadSvg}
        className="rounded bg-background/80 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
        title="下载 SVG"
        aria-label="导出 SVG"
      >
        SVG
      </button>
      <button
        onClick={() => void downloadPdf()}
        className="rounded bg-background/80 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
        title="下载 PDF"
        aria-label="导出 PDF"
      >
        PDF
      </button>
    </div>
  )
}

/**
 * 图表卡片内层（docs/UI设计规范.md 3.7）。
 * 支持：折线/柱状/饼/散点（recharts）+ 热力图（自定义 SVG）；
 * 右上角悬浮工具：设置（本地配置覆盖）/ PNG / SVG / PDF 导出。
 */
export function ChartBlock({ content, savable = false, sessionId }: Props) {
  const chartRef = useRef<HTMLDivElement>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sqlOpen, setSqlOpen] = useState(false)
  const [fullscreenOpen, setFullscreenOpen] = useState(false)
  const [settings, setSettings] = useState<ChartSettings>(DEFAULT_SETTINGS)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const effective: ChartContent = useMemo(
    () => ({
      ...content,
      title: settings.title?.trim() || content.title,
      x_label: settings.x_label?.trim() || content.x_label,
      y_label: settings.y_label?.trim() || content.y_label,
    }),
    [content, settings],
  )
  const colors = useMemo(
    () => resolveColors(content.series ?? [], settings.seriesColors),
    [content.series, settings.seriesColors],
  )
  const title = effective.title || '图表导出'

  /** 收藏到个人看板：快照当前生效的 ChartContent（含标题/轴标签的本地定制）与查询 SQL */
  const saveToBoard = async () => {
    if (saveState !== 'idle') return
    setSaveState('saving')
    try {
      await api.post('/saved-charts', {
        title: effective.title || '图表',
        session_id: sessionId ?? null,
        chart_content: effective,
        query: content.query ?? null,
      })
      setSaveState('saved')
    } catch {
      setSaveState('error')
    }
  }

  const hasData =
    ((content.series ?? []).length > 0 && content.series[0].x.length > 0) ||
    (content.matrix?.values.length ?? 0) > 0
  if (!hasData) {
    return (
      <div className="flex h-40 items-center justify-center rounded-md bg-muted/50 text-[13px] text-muted-foreground">
        暂无图表数据
      </div>
    )
  }
  return (
    <div className="relative w-full">
      <div ref={chartRef} className="group relative w-full">
        <div className="mb-3 text-[13px] font-semibold text-foreground">{effective.title ?? '图表'}</div>
        <ChartToolbar
          chartRef={chartRef}
          title={title}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenSql={() => setSqlOpen(true)}
          onOpenFullscreen={() => setFullscreenOpen(true)}
          showSql={!!content.query}
          saveState={saveState}
          onSave={savable ? () => void saveToBoard() : undefined}
        />
        <ChartPanel content={effective} colors={colors} />
      </div>
      <ChartSettingsDialog
        content={content}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onApply={(next) => {
          setSettings(next)
          setSettingsOpen(false)
        }}
      />
      {content.query ? (
        <SqlQueryDialog sql={content.query} open={sqlOpen} onOpenChange={setSqlOpen} />
      ) : null}
      <ChartFullscreenDialog
        content={effective}
        colors={colors}
        open={fullscreenOpen}
        onOpenChange={setFullscreenOpen}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenSql={() => setSqlOpen(true)}
        showSql={!!content.query}
      />
    </div>
  )
}
