/**
 * 定时任务（Automation）契约类型（镜像 backend/app/schemas/automation.py，CLAUDE.md 5.4）。
 * 改一端必须同步另一端。
 */
import type { ChartContent, TableContent } from '@/types/message'

export type AutomationAction = 'sql_report'

export interface AutomationChannelBinding {
  enabled: boolean
  channel_id: string | null
}

export interface AutomationNotification {
  on_success: AutomationChannelBinding
  on_failure: AutomationChannelBinding
}

/** 参数模板：SQL（含 ${var} 占位符）+ 用户变量默认值 + 可选图表配置 */
export interface AutomationParams {
  sql_text: string
  datasource_id: string | null
  variable_defaults?: Record<string, string>
  chart_config?: AutomationChartConfig | null
}

export interface AutomationChartConfig {
  chart_type: 'line' | 'bar' | 'pie' | 'scatter' | 'heatmap'
  dimension: string
  measures: string[]
  title?: string | null
}

export interface AutomationInfo {
  id: string
  name: string
  description: string | null
  action: string
  params: AutomationParams
  cron_expression: string
  timezone: string
  enabled: boolean
  notification: AutomationNotification | null
  last_run_at: string | null
  last_status: 'success' | 'failed' | 'running' | null
  next_run_at: string | null
  datasource_name: string | null
  /** cron 中文描述（后端 describe_cron 回填） */
  readable: string | null
  created_at: string | null
  updated_at: string | null
}

/** 单次运行记录（result 为 {table, chart?} 结果快照） */
export interface AutomationRunInfo {
  id: string
  automation_id: string
  status: 'running' | 'success' | 'failed'
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  error: string | null
  params: Record<string, unknown> | null
  result: { table: TableContent; chart?: ChartContent } | null
}

/** parse 待确认草稿（不落库；cron 已由后端生成，datasource_id 已锁定） */
export interface AutomationDraft {
  name: string
  description: string | null
  params: AutomationParams
  cron_expression: string
  timezone: string
  notification: AutomationNotification | null
  readable: string | null
  datasource_name: string | null
}
