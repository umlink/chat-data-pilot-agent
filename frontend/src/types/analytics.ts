/**
 * 分析增强契约类型（镜像 backend/app/schemas/saved_chart.py / report.py 及 stats 端点出参）。
 * 改一端必须同步另一端（CLAUDE.md 5.4）。
 */
import type { ChartContent, TableContent } from '@/types/message'

// ---------- 收藏图表（个人看板） ----------

export interface SavedChartInfo {
  id: string
  session_id: string | null
  title: string
  chart_content: ChartContent
  query: string | null
  created_at: string | null
}

// ---------- 定时报告 ----------

export type ScheduleType = 'daily' | 'weekly' | 'monthly'

export interface ReportMeasure {
  column: string
  agg: 'sum' | 'avg' | 'count' | 'max' | 'min' | null
  name: string | null
}

export interface ReportChartConfig {
  chart_type: 'line' | 'bar' | 'pie' | 'scatter' | 'heatmap'
  dimension: string
  measures: ReportMeasure[]
  title: string | null
}

export interface ReportInfo {
  id: string
  name: string
  datasource_id: string | null
  datasource_name: string | null
  sql_text: string
  chart_config: ReportChartConfig | null
  enabled: boolean
  schedule_type: ScheduleType
  schedule_time: string
  day_of_week: number | null
  day_of_month: number | null
  last_run_at: string | null
  last_status: 'success' | 'failed' | 'running' | null
  next_run_at: string | null
  created_at: string | null
  updated_at: string | null
}

/** 报告单次运行记录（result 为 {table, chart?} 结果快照） */
export interface ReportRunInfo {
  id: string
  report_id: string
  status: 'running' | 'success' | 'failed'
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  error: string | null
  result: { table: TableContent; chart?: ChartContent } | null
}

// ---------- Token 用量统计（GET /stats/tokens） ----------

export interface TokenDailyPoint {
  date: string
  tokens: number
  calls: number
  avg_latency_ms: number
}

export interface TokenModelRow {
  model: string
  tokens: number
  calls: number
  avg_latency_ms: number
}

export interface TokenStats {
  days: number
  summary: {
    total_tokens: number
    total_calls: number
    avg_latency_ms: number
  }
  daily: TokenDailyPoint[]
  models: TokenModelRow[]
}
