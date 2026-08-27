/**
 * 上下文 token 估算（PRD 3.1.1）：对话接近上下文上限时提示新建会话/总结。
 * 有 usage 元数据用实际值，缺省按文本/代码长度折算（与后端 _estimate_tokens 口径一致）。
 */
import type { Message } from '@/types/message'

/** 上下文窗口假设值（按默认模型保守口径） */
export const CONTEXT_LIMIT = 32_000
/** 达到该比例即提示「接近上限」 */
export const CONTEXT_WARN_RATIO = 0.8

function estimateTextTokens(text: string): number {
  if (!text) return 0
  // 中文约 1 token/2 字符；拉丁约 1 token/4 字符
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const rest = text.length - cjk
  return Math.ceil(cjk / 2 + rest / 4)
}

export function estimateContextTokens(messages: Message[]): number {
  // 服务端每条 assistant 消息的 usage.total_tokens 是该时刻完整上下文的累计值，
  // 逐条累加会重复计数 prompt；取最新一条作为基线，其后无 usage 的消息按文本折算叠加
  let total = 0
  for (const m of messages) {
    const usage = m.metadata.usage as { total_tokens?: number } | undefined
    if (typeof usage?.total_tokens === 'number' && usage.total_tokens > 0) {
      total = usage.total_tokens
      continue
    }
    for (const b of m.blocks) {
      const c = b.content
      if (b.type === 'text') total += estimateTextTokens(String(c.text ?? ''))
      else if (b.type === 'code') total += Math.ceil(String(c.code ?? '').length / 4)
    }
  }
  return total
}
