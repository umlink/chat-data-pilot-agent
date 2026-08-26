import { useRef } from 'react'
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

interface Props {
  content: ChartContent
}

// 图表主色固定取语义 token（docs/UI设计规范.md 1.1 chart-1..5 橙色阶）
const TOKENS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
]

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

/** 柱状主色渐变橙 400→600（docs/UI设计规范.md 3.7） */
const BAR_GRADIENT_ID = 'dpChartBarGrad'

function BarPanel({ content }: { content: ChartContent }) {
  const { series, y_label } = content
  const rows = toRows(series)
  const single = series.length === 1
  return (
    <ChartContainer config={buildConfig(series)} className="aspect-auto h-56 w-full">
      <BarChart data={rows} accessibilityLayer margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
        <defs>
          <linearGradient id={BAR_GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-2)" />
            <stop offset="100%" stopColor="var(--chart-3)" />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="x" tickLine={false} axisLine={false} tick={{ fontSize: 9 }} dy={6} />
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
            <Bar key={s.name} dataKey={s.name} fill={TOKENS[i % TOKENS.length]} radius={[4, 4, 0, 0]} />
          ))
        )}
        {series.length >= 2 && <ChartLegend content={<ChartLegendContent />} />}
      </BarChart>
    </ChartContainer>
  )
}

function LinePanel({ content }: { content: ChartContent }) {
  const { series, y_label } = content
  return (
    <ChartContainer config={buildConfig(series)} className="aspect-auto h-56 w-full">
      <LineChart data={toRows(series)} accessibilityLayer margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="x" tickLine={false} axisLine={false} tick={{ fontSize: 9 }} dy={6} />
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
            stroke={TOKENS[i % TOKENS.length]}
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

function PiePanel({ content }: { content: ChartContent }) {
  const s = content.series[0]
  if (!s) {
    return <div className="py-10 text-center text-[13px] text-muted-foreground">暂无图表数据</div>
  }
  const data = s.x.map((cat, i) => ({ x: cat, value: s.y[i] ?? 0 }))
  return (
    <ChartContainer config={buildConfig([s])} className="aspect-auto h-56 w-full">
      <PieChart accessibilityLayer>
        <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
        <Pie data={data} dataKey="value" nameKey="x" innerRadius={48} outerRadius={76} paddingAngle={2} strokeWidth={0}>
          {data.map((_, i) => (
            <Cell key={i} fill={TOKENS[i % TOKENS.length]} />
          ))}
        </Pie>
        <ChartLegend content={<ChartLegendContent />} />
      </PieChart>
    </ChartContainer>
  )
}

function ScatterPanel({ content }: { content: ChartContent }) {
  const { series } = content
  return (
    <ChartContainer config={buildConfig(series)} className="aspect-auto h-56 w-full">
      <ScatterChart accessibilityLayer margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
        <CartesianGrid vertical={false} />
        <XAxis type="number" dataKey="x" tickLine={false} axisLine={false} tick={{ fontSize: 9 }} dy={6} />
        <YAxis type="number" tickLine={false} axisLine={false} tick={{ fontSize: 9 }} width={34} />
        <ChartTooltip content={<ChartTooltipContent indicator="dot" />} cursor={{ strokeDasharray: '3 3' }} />
        {series.map((s, i) => (
          <Scatter key={s.name} name={s.name} data={toRows(series)} dataKey={s.name} fill={TOKENS[i % TOKENS.length]} />
        ))}
        {series.length >= 2 && <ChartLegend content={<ChartLegendContent />} />}
      </ScatterChart>
    </ChartContainer>
  )
}

/** 把当前图表 SVG 序列化为文件并触发下载（PNG via canvas / SVG 直接下载） */
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

  const downloadPng = () => {
    const svg = chartRef.current?.querySelector('svg')
    if (!svg) return
    const clone = svg.cloneNode(true) as SVGElement
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    const bbox = svg.getBoundingClientRect()
    const w = bbox.width || 800
    const h = bbox.height || 400
    clone.setAttribute('width', String(w))
    clone.setAttribute('height', String(h))
    const svgStr = new XMLSerializer().serializeToString(clone)
    const img = new Image()
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = w * 2
      canvas.height = h * 2
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(2, 2)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0, w, h)
      canvas.toBlob((pngBlob) => {
        if (!pngBlob) return
        const pngUrl = URL.createObjectURL(pngBlob)
        const a = document.createElement('a')
        a.href = pngUrl
        a.download = `${title}.png`
        a.click()
        URL.revokeObjectURL(pngUrl)
      }, 'image/png')
      URL.revokeObjectURL(url)
    }
    img.src = url
  }

  return { downloadSvg, downloadPng }
}

function ExportButtons({
  chartRef,
  title,
}: {
  chartRef: React.RefObject<HTMLDivElement | null>
  title: string
}) {
  const { downloadSvg, downloadPng } = useChartExport(chartRef, title)
  return (
    <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      <button
        onClick={downloadPng}
        className="rounded bg-background/80 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
        title="下载 PNG"
      >
        PNG
      </button>
      <button
        onClick={downloadSvg}
        className="rounded bg-background/80 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
        title="下载 SVG"
      >
        SVG
      </button>
    </div>
  )
}

/**
 * 图表卡片内层（docs/UI设计规范.md 3.7）。
 * heatmap 离开 recharts 原生能力范围，M4 由增强面板补齐，此处保留降级占位。
 */
export function ChartBlock({ content }: Props) {
  const chartRef = useRef<HTMLDivElement>(null)
  const title = content.title || '图表导出'
  const hasData =
    (content.series.length > 0 && content.series[0].x.length > 0) ||
    (content.matrix?.values.length ?? 0) > 0
  if (!hasData) {
    return (
      <div className="flex h-40 items-center justify-center rounded-md bg-muted/50 text-[13px] text-muted-foreground">
        暂无图表数据
      </div>
    )
  }
  if (content.chart_type === 'heatmap') {
    return (
      <div className="flex h-40 items-center justify-center rounded-md bg-muted/50 text-[13px] text-muted-foreground">
        📊 热力图（M4 增强渲染）
      </div>
    )
  }
  return (
    <div ref={chartRef} className="group relative w-full">
      <ExportButtons chartRef={chartRef} title={title} />
      {content.chart_type === 'bar' && <BarPanel content={content} />}
      {content.chart_type === 'line' && <LinePanel content={content} />}
      {content.chart_type === 'pie' && <PiePanel content={content} />}
      {content.chart_type === 'scatter' && <ScatterPanel content={content} />}
    </div>
  )
}