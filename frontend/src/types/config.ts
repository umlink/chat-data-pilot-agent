/**
 * 配置 / 日志契约类型。
 * 与 backend/app/api/config.py、backend/app/api/logs.py 保持一致：
 * - GET /api/config  → { <key>: { <field>: value } }（敏感字段已掩码 ******）
 * - POST /api/config/update { updates: { <key>: { field: value } } }
 * - POST /api/config/test  → { ok, model?, latency_ms?, error? }
 * - GET /api/logs?category=audit&page_size=N → { items: LogEntry[], total, ... }
 */

/** 一个配置项的字段集合（key → value 无内嵌对象） */
export type ConfigValue = Record<string, unknown>

/** 全量配置：扁平 key → 字段映射 */
export type ConfigMap = Record<string, ConfigValue>

/** 配置掩码（MASKED，见 backend/app/core/security.py） */
export const MASKED = '******'

/** POST /api/config/test 返回 */
export interface ConfigTestResult {
  ok: boolean
  model?: string
  latency_ms?: number
  error?: string
}

/** 日志条目（后端 logs 表字段 + audit context） */
export interface LogEntry {
  id: string
  timestamp: string
  level: string
  category: string
  message: string
  /** audit 日志含 user/resource/action */
  context?: Record<string, unknown>
}

/** GET /api/logs 分页响应 */
export interface LogsPage {
  items: LogEntry[]
  total: number
  page: number
  page_size: number
}
