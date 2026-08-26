/**
 * LLM 供应商契约类型。
 * 与 backend/app/schemas/llm_provider.py 镜像（改一端须同步另一端）：
 * - GET  /api/llm/providers              → LlmProvider[]（api_key 掩码）
 * - POST /api/llm/providers              → 新增（首个自动默认）
 * - POST /api/llm/providers/update       → 更新（api_key 掩码/空串=保留旧值）
 * - POST /api/llm/providers/delete       → 删除（删默认自动提升）
 * - POST /api/llm/providers/{id}/set-default
 * - POST /api/llm/providers/{id}/test    → { ok, model?, latency_ms?, error? }
 */

export type LlmProviderType = 'openai' | 'anthropic'

export interface LlmProvider {
  id: string
  name: string
  type: LlmProviderType
  base_url: string
  /** 出参恒为掩码（******）；提交留空/掩码 = 保留旧密文 */
  api_key: string
  models: string[]
  default_model: string
  is_default: boolean
  created_at?: string
  updated_at?: string
}

/** 新建/编辑表单载荷 */
export interface LlmProviderForm {
  name: string
  type: LlmProviderType
  base_url: string
  api_key: string
  models: string[]
  default_model: string
}

export interface ProviderTestResult {
  ok: boolean
  model?: string
  latency_ms?: number
  error?: string
}
