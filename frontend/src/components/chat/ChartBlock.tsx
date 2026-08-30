import { useMemo, useRef, useState } from 'react'
import { Maximize2, Send, Settings2, Star } from 'lucide-react'
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
import { PushToChannelDialog } from './PushToChannelDialog'
import { SqlQueryDialog } from './SqlQueryDialog'

interface Props {
  content: ChartContent
  /** 展示「收藏到看板」按钮（对话中的图表可收藏；看板页自身不重复收藏） */
  savable?: boolean
  /** 溯源会话 ID（收藏快照关联会话；会话删除后快照保留） */
  sessionId?: string
  /** 是否渲染图表内部标题（看板卡片头部已展示标题，传 false 避免重复） */
  showTitle?: boolean
  /** 在看板等无标题场景为顶部 hover 工具条预留高度，使其不压盖图表绘图区域 */
  reserveToolbarTop?: boolean
}

// 折线/柱状等系列主色取语义 token（docs/UI设计规范.md 1.1 chart-1..5 深橙色阶）
const TOKENS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
]

// 饼图专用多色相调色板（绿 / 蓝 / 紫 / 橙 / 玫红 / 青）：
// 占比图需扇区之间强区分，不随折线/柱状的橙色阶，否则仍是同色深浅。
const PIE_PALETTE = [
  'oklch(0.62 0.17 150)',
  'oklch(0.58 0.19 250)',
  'oklch(0.58 0.22 295)',
  'oklch(0.7 0.18 65)',
  'oklch(0.58 0.22 20)',
  'oklch(0.62 0.14 200)',
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

/** 系列扁平化为 recharts 行：[{ x, [seriesName]: y }]
 * 注意：y 可能为 NaN/null/数字字符串（后端聚合缺失或透传异常）。NaN 会破坏 monotone 曲线导致断线，
 * 这里统一归一为 null（保留缺失语义）；能数值化的字符串转 number，避免折线拿到字符串无法连线。 */
function toRows(series: ChartSeries[]): Record<string, string | number | null>[] {
  const cats = series[0]?.x ?? []
  return cats.map((cat, i) => {
    const row: Record<string, string | number | null> = { x: cat }
    for (const s of series) {
      const v = s.y[i]
      if (v == null) {
        row[s.name] = null
      } else if (typeof v === 'number') {
        row[s.name] = Number.isFinite(v) ? v : null
      } else {
        const n = Number(v)
        row[s.name] = Number.isFinite(n) ? n : null
      }
    }
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
            connectNulls
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
  // 饼图取色按「扇区（数据项）」遍历，用独立多色相 PIE_PALETTE：
  // 用户自定义色板优先；不足时循环 PIE_PALETTE，保证每个扇区颜色可以不同。
  const sectors = data.map((_, i) => colors[i] ?? PIE_PALETTE[i % PIE_PALETTE.length])
  return (
    <ChartContainer config={buildConfig([s])} className={chartClass}>
      <PieChart accessibilityLayer>
        <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
        <Pie data={data} dataKey="value" nameKey="x" innerRadius={48} outerRadius={76} paddingAngle={2} strokeWidth={0}>
          {sectors.map((c, i) => (
            <Cell key={i} fill={c} />
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
  // 散点 x 可能是数值（相关分析）或类别（分组散点）：全数值才用数值轴，否则类别轴，
  // 避免 type="number" 拿到字符串导致散点无法定位
  const cats = series[0]?.x ?? []
  const numericX = cats.length > 0 && cats.every((v) => Number.isFinite(Number(v)))
  return (
    <ChartContainer config={buildConfig(series)} className={chartClass}>
      <ScatterChart accessibilityLayer margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          type={numericX ? 'number' : 'category'}
          dataKey="x"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 9 }}
          dy={6}
          allowDuplicatedCategory={false}
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
// 热力图渐变（低→高，橙色阶）：与其他单一色图表统一用橙色系，靠深浅区分数值强弱，
// 色相固定在 ~55 与 --chart-N 保持一致，避免多色相/青绿带偏「低→高」的连续观感。
const HEAT_GRADIENT = [
  'oklch(0.95 0.06 55)',
  'oklch(0.84 0.11 52)',
  'oklch(0.72 0.17 52)',
  'oklch(0.58 0.19 48)',
  'oklch(0.44 0.15 40)',
]

function heatColor(value: number, min: number, max: number): string {
  if (max <= min) return HEAT_GRADIENT[2]
  const t = Math.min(1, Math.max(0, (value - min) / (max - min)))
  return HEAT_GRADIENT[Math.min(HEAT_GRADIENT.length - 1, Math.floor(t * HEAT_GRADIENT.length))]
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
          data-dp-chart-plot=""
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
        {HEAT_GRADIENT.map((t) => (
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

/** 把任意 CSS 颜色（含 oklch()/var() 已解析的现代色彩）栅格化后转成通用 rgb()。
 * rgb() 在 standalone SVG / SVG-as-image 中兼容性最好；oklch 等脱离页面后可能不被解析。 */
function toCssRgb(color: string): string {
  if (!color || color === 'none' || color === 'transparent' || color.startsWith('url(')) return color
  try {
    const c = document.createElement('canvas')
    c.width = c.height = 1
    const ctx = c.getContext('2d')
    if (!ctx) return color
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, 1, 1)
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return `rgb(${d[0]}, ${d[1]}, ${d[2]})`
  } catch {
    return color
  }
}

/**
 * 图表导出自包含化：把外部 CSS（recharts 类名）计算出的样式内联到 SVG 元素上。
 * 否则独立打开的 SVG 不加载页面 CSS，轴标签/文字/网格线会丢失样式而错乱。 */
function inlineSvgStyles(root: SVGElement): SVGSVGElement {
  const clone = root.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  // 颜色相关属性：需从原始（挂载中）节点取计算值并转成独立文档可用的 rgb()，
  // 否则 fill/stroke 仍是 var(--chart-*) 引用或 oklch() 等现代函数，脱离页面后无法解析。
  const COLOR_PROPS = ['fill', 'stroke', 'stop-color', 'color']
  const STYLE_PROPS = [
    'fill-opacity',
    'stroke-opacity',
    'stroke-width',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-dasharray',
    'opacity',
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'text-anchor',
    'letter-spacing',
    'dominant-baseline',
  ]
  // 在「原始」节点上遍历计算样式（克隆节点脱离 DOM，CSS 变量 --chart-* 无法解析，取值会退回 var() 引用）
  const originals = [root, ...root.querySelectorAll<SVGElement>('*')]
  const clones = [clone, ...clone.querySelectorAll<SVGElement>('*')]
  const count = Math.min(originals.length, clones.length)
  for (let i = 0; i < count; i++) {
    const cs = window.getComputedStyle(originals[i])
    for (const p of COLOR_PROPS) {
      const v = cs.getPropertyValue(p).trim()
      if (!v || v === 'none' || v === 'transparent') continue
      clones[i].setAttribute(p, toCssRgb(v))
    }
    for (const p of STYLE_PROPS) {
      const v = cs.getPropertyValue(p).trim()
      if (!v || v === 'none') continue
      clones[i].setAttribute(p, v)
    }
  }
  // 关键：导出尺寸必须沿用 SVG 自身的坐标系（width/height attribute 与 viewBox），
  // 绝不能用 getBoundingClientRect 的 CSS 渲染尺寸覆盖——recharts 的内容坐标基于其自身
  // viewBox（如 0 0 800 500）绘制，被覆盖为不同尺寸后视角框偏移，导出的区域就错位/只截一角。
  const parseNum = (v: string | null): number | null => {
    // 只接受纯数值字符串；"100%" 这类相对值不参与坐标换算，视为缺失
    if (!v || !/^\d+(\.\d+)?$/.test(v.trim())) return null
    const n = parseFloat(v)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  let w = parseNum(clone.getAttribute('width')) ?? 0
  let h = parseNum(clone.getAttribute('height')) ?? 0
  if (w <= 0 || h <= 0) {
    // 回退：仅当 SVG 未定义数值宽高（如 width="100%"）时才取 CSS 渲染尺寸填数
    const bbox = root.getBoundingClientRect()
    w = bbox.width || 800
    h = bbox.height || 400
    clone.setAttribute('width', String(w))
    clone.setAttribute('height', String(h))
  }
  // viewBox 优先沿用 SVG 自带（recharts 会写 0 0 w h）；缺失时才以自身宽高补齐
  const vb = clone.getAttribute('viewBox')?.trim()
  if (!vb) {
    clone.setAttribute('viewBox', `0 0 ${w} ${h}`)
  }
  return clone
}

function triggerDownload(dataUrl: string, filename: string, revoke: boolean): void {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // blob URL 等需异步撤销（点击后即刻撤销在某些浏览器会失败）
  window.setTimeout(() => revoke && URL.revokeObjectURL(dataUrl), 1000)
}

/** 把图表 SVG 位图化为 canvas（PNG/PDF 共用管道，2x 高清） */
function svgToCanvas(svg: SVGElement, scale = 2): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    const clone = inlineSvgStyles(svg)
    const svgStr = new XMLSerializer().serializeToString(clone)
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const w = clone.width.baseVal.value || 800
      const h = clone.height.baseVal.value || 400
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

/** 在容器内精确定位图表绘图 SVG（而非工具栏上的 lucide 图标）。
 * recharts 输出 <svg class="recharts-surface">；自定义热力图标记 data-dp-chart-plot。 */
function findChartSvg(container: HTMLElement | null): SVGSVGElement | null {
  if (!container) return null
  return container.querySelector<SVGSVGElement>('svg.recharts-surface, svg[data-dp-chart-plot]')
}

/** 当前图表导出：SVG 直下 / PNG / PDF（jspdf） */
function useChartExport(chartRef: React.RefObject<HTMLDivElement | null>, title: string) {
  const downloadSvg = () => {
    const svg = findChartSvg(chartRef.current)
    if (!svg) return
    const clone = inlineSvgStyles(svg)
    const blob = new Blob([new XMLSerializer().serializeToString(clone)], {
      type: 'image/svg+xml;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    triggerDownload(url, `${title}.svg`, true)
  }

  const downloadPng = async () => {
    const svg = findChartSvg(chartRef.current)
    if (!svg) return
    const canvas = await svgToCanvas(svg)
    if (!canvas) return
    canvas.toBlob((pngBlob) => {
      if (!pngBlob) return
      const url = URL.createObjectURL(pngBlob)
      triggerDownload(url, `${title}.png`, true)
    }, 'image/png')
  }

  const downloadPdf = async () => {
    const svg = findChartSvg(chartRef.current)
    if (!svg) return
    const canvas = await svgToCanvas(svg)
    if (!canvas) return
    // jspdf 体积较大，按需加载（仅首次点击 PDF 时拉取）
    const { jsPDF } = await import('jspdf')
    const w = canvas.width / 2
    const h = canvas.height / 2
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
              {(content.series ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">该图表类型暂不支持系列配色</p>
              ) : null}
              {(content.series ?? []).map((s, i) => {
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
  onPush,
}: {
  chartRef: React.RefObject<HTMLDivElement | null>
  title: string
  onOpenSettings: () => void
  onOpenSql: () => void
  onOpenFullscreen: () => void
  showSql: boolean
  saveState?: 'idle' | 'saving' | 'saved' | 'error'
  onSave?: () => void
  onPush?: () => void
}) {
  const { downloadSvg, downloadPng, downloadPdf } = useChartExport(chartRef, title)
  return (
    // hover 工具条需浮在图表 svg 之上：svg 在 DOM 中更靠后且同为 auto 层级，会覆盖工具条导致点不到
    <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
      {onPush && (
        <button
          onClick={onPush}
          className="rounded bg-background/80 px-1.5 py-1 text-muted-foreground hover:text-foreground"
          title="推送到通知渠道"
          aria-label="推送到通知渠道"
        >
          <Send className="size-3.5" />
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
export function ChartBlock({ content, savable = false, sessionId, showTitle = true, reserveToolbarTop = false }: Props) {
  const chartRef = useRef<HTMLDivElement>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sqlOpen, setSqlOpen] = useState(false)
  const [fullscreenOpen, setFullscreenOpen] = useState(false)
  const [pushOpen, setPushOpen] = useState(false)
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
      <div ref={chartRef} className={cn('group relative w-full', reserveToolbarTop && 'pt-8')}>
        {showTitle ? (
          <div className="mb-3 text-[13px] font-semibold text-foreground">{effective.title ?? '图表'}</div>
        ) : null}
        <ChartToolbar
          chartRef={chartRef}
          title={title}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenSql={() => setSqlOpen(true)}
          onOpenFullscreen={() => setFullscreenOpen(true)}
          showSql={!!content.query}
          saveState={saveState}
          onSave={savable ? () => void saveToBoard() : undefined}
          onPush={() => setPushOpen(true)}
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
      <PushToChannelDialog
        open={pushOpen}
        onOpenChange={setPushOpen}
        subject={effective.title || '图表摘要'}
        body={`图表「${effective.title || '未命名图表'}」\n类型：${effective.chart_type}\n数据点：${(effective.series?.[0]?.x ?? []).length}`}
      />
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
