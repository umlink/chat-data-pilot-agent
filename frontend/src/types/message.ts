/**
 * Block / 消息类型契约。
 * 与 backend/app/schemas/common.py 及 docs/Block与协议规范.md 第 1、2 章保持一致。
 */

export type BlockStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected'

export type BlockType =
  | 'text'
  | 'code'
  | 'table'
  | 'chart'
  | 'confirmation'
  | 'insights'
  | 'suggestions'
  | 'progress'
  | 'error'
  | 'attachment'

export interface BlockAction {
  action: string
  label: string
  payload?: Record<string, unknown>
}

// ---------- 各类型 content ----------
export interface TextContent {
  text: string
}

export interface CodeExecution {
  task_id?: string
  status?: 'running' | 'success' | 'failed'
  error?: string
  duration_ms?: number
}

export interface CodeContent {
  language: 'sql' | 'python'
  code: string
  editable: boolean
  execution?: CodeExecution
}

export interface TableColumn {
  key: string
  label: string
  dtype: 'number' | 'string' | 'date' | 'boolean'
}

export interface TableContent {
  columns: TableColumn[]
  rows: Record<string, unknown>[]
  total: number
  truncated: boolean
  query?: string
}

export interface ChartSeries {
  name: string
  x: (number | string)[]
  y: number[]
}

export interface ChartMatrix {
  x_categories: string[]
  y_categories: string[]
  values: number[][]
}

export interface ChartContent {
  chart_type: 'line' | 'bar' | 'pie' | 'scatter' | 'heatmap'
  title?: string
  series: ChartSeries[]
  matrix?: ChartMatrix
  x_label?: string
  y_label?: string
  source_block_id?: string
  query?: string
}

export interface ConfirmationContent {
  operation: 'execute_sql' | 'execute_python' | 'delete_attachment' | 'truncate_table'
  title: string
  description: string
  sql?: string
  risk_level: 'high' | 'medium'
  confirmed?: boolean
  result_block_id?: string
  /** 确认后执行所用的数据源（卡片生成时记录，避免落到默认数据源导致方言不匹配） */
  datasource_id?: string | null
  /** 目标数据源名称（仅展示用） */
  datasource_name?: string | null
}

export interface InsightItem {
  title: string
  detail: string
  severity?: 'info' | 'positive' | 'warning'
}

export interface InsightsContent {
  items: InsightItem[]
}

export interface SuggestionItem {
  text: string
  message: string
}

export interface SuggestionsContent {
  items: SuggestionItem[]
}

export interface ProgressStep {
  name: string
  status: 'pending' | 'running' | 'done' | 'failed'
}

export interface ProgressContent {
  task_id: string
  steps: ProgressStep[]
  percent: number
  current_step?: string
  cancellable: boolean
}

export interface ErrorContent {
  code: string
  message: string
  detail?: string
  suggestion?: string
  retryable: boolean
}

export interface AttachmentContent {
  attachment_id: string
  file_name: string
  file_type: 'csv' | 'excel' | 'json'
  file_size: number
  status: 'uploading' | 'parsing' | 'ready' | 'failed'
  sheet_name?: string
  row_count?: number
  columns?: { name: string; dtype: string }[]
  preview_rows?: Record<string, unknown>[]
  error?: string
  /** 附件已被用户移除（block 保留但引用失效，PRD 3.1.5；由 POST /upload/{id}/block-state 持久化） */
  removed?: boolean
}

// content 具体结构由 type 决定；运行时以对象形式访问
export type BlockContent =
  | TextContent
  | CodeContent
  | TableContent
  | ChartContent
  | ConfirmationContent
  | InsightsContent
  | SuggestionsContent
  | ProgressContent
  | ErrorContent
  | AttachmentContent

export interface Block {
  id: string
  type: BlockType
  status: BlockStatus
  /**
   * content 形状由 type 决定（见上方各 content 接口）。
   * 渲染端按 type 对应形状读取字段。
   */
  content: Record<string, unknown>
  actions?: BlockAction[]
  parent_block_id?: string
  created_at?: string
}

export interface Message {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system'
  blocks: Block[]
  metadata: Record<string, unknown>
  created_at?: string
}

export interface SessionInfo {
  id: string
  title: string
  created_at?: string
  updated_at?: string
}