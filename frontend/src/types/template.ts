/**
 * 模板契约类型（与 backend/app/schemas/template.py 镜像，改一端须同步另一端）。
 * 模板 = 可复用的分析配置（数据源 + SQL + 图表配置），归属当前用户。
 */

export interface Template {
  id: string
  name: string
  description?: string | null
  datasource_id?: string | null
  sql_text?: string | null
  chart_config?: Record<string, unknown> | null
  created_at?: string
  updated_at?: string
}

export interface TemplateForm {
  name: string
  description?: string
  datasource_id?: string
  sql_text?: string
  chart_config?: Record<string, unknown>
}
