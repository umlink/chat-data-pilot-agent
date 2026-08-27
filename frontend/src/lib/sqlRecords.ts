import type { Message } from '@/types/message'

/** 会话内一条 SQL 记录（来源：code 执行块 / 表格结果 / 图表结果） */
export interface SqlRecord {
  id: string
  kind: 'code' | 'table' | 'chart'
  sql: string
  status?: string
}

/** 收集当前会话所有可追溯 SQL（PRD 5.2：SQL 历史统一查看） */
export function collectSql(messages: Message[]): SqlRecord[] {
  const out: SqlRecord[] = []
  for (const msg of messages) {
    for (const block of msg.blocks ?? []) {
      const content = block.content ?? {}
      if (block.type === 'code' && content.language === 'sql' && content.code) {
        out.push({
          id: `${msg.id}-${block.id}`,
          kind: 'code',
          sql: String(content.code),
          status: (content.execution as { status?: string } | undefined)?.status,
        })
      } else if (block.type === 'table' && content.query) {
        out.push({ id: `${msg.id}-${block.id}`, kind: 'table', sql: String(content.query) })
      } else if (block.type === 'chart' && content.query) {
        out.push({ id: `${msg.id}-${block.id}`, kind: 'chart', sql: String(content.query) })
      }
    }
  }
  return out
}
