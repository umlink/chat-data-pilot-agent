/**
 * Mock SSE 流（VITE_USE_MOCK=true 时由 streamSSE 先路由到此处）。
 * 按 docs/Block与协议规范.md 第 3 章逐帧回放：token → code → table → chart
 * → insights → suggestions → done；id 单调递增。返回 true 表示已处理。
 */
import type { SSECallbacks } from '../sseClient'

const MONTHS = ['1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月']
const SALES = [182, 205, 198, 246, 312, 289, 268, 231]
const SQL = `SELECT
  DATE_TRUNC('month', order_date) AS month,
  SUM(amount)                     AS sales_amount
FROM orders
WHERE order_date >= CURRENT_DATE - INTERVAL '8 month'
GROUP BY 1
ORDER BY 1;`

interface StreamBody {
  session_id?: unknown
  message?: unknown
  text_block_id?: unknown
}

export async function mockStream(
  url: string,
  body: unknown,
  cb: SSECallbacks,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!url.includes('/chat/stream')) return false

  const textBlockId = String((body as StreamBody).text_block_id ?? '')
  const question = String((body as StreamBody).message ?? '').slice(0, 48)

  const timers: number[] = []
  let id = 0
  let cancelled = false
  let resolveFinished: (() => void) | null = null
  const finished = new Promise<void>((r) => {
    resolveFinished = r
  })
  // 经闭包调用，避免顶层 CFA 将 resolveFinished 收窄为 null
  const settle = () => resolveFinished?.()

  const emit = (event: string, data: Record<string, unknown>) => {
    if (cancelled) return
    id += 1
    cb.onEvent?.({ event, id, data })
  }
  const later = (ms: number, fn: () => void) => {
    timers.push(window.setTimeout(fn, ms))
  }
  const clearAll = () => {
    for (const t of timers) window.clearTimeout(t)
    timers.length = 0
  }
  const onAbort = () => {
    cancelled = true
    clearAll()
    settle()
  }
  const finish = () => {
    cb.onClose?.()
    signal?.removeEventListener('abort', onAbort)
    clearAll()
    settle()
  }

  if (signal?.aborted) {
    cancelled = true
    settle()
    return true
  }
  signal?.addEventListener('abort', onAbort)

  cb.onOpen?.()

  // 1) 文本 token 流（客户端预置 text block，经 text_block_id 定位）
  const answer = `已收到问题：${question}。\n按月份汇总销售额，整体呈**先升后降**趋势：5 月达到峰值 312 万，6 月起连续回落。明细见下方表格与图表。`
  const chunks: string[] = []
  for (let i = 0; i < answer.length; i += 6) chunks.push(answer.slice(i, i + 6))
  let t = 0
  for (const chunk of chunks) {
    later(t, () => emit('token', { block_id: textBlockId, content: chunk }))
    t += 34
  }

  // 2) SQL 代码块（执行成功状态）
  later((t += 140), () =>
    emit('block_start', {
      block_id: 'mb_code',
      type: 'code',
      content: { language: 'sql', code: SQL, editable: true },
    }),
  )
  later((t += 300), () => emit('block_end', { block_id: 'mb_code', status: 'completed' }))

  // 3) 数据表格
  later((t += 140), () =>
    emit('block_start', {
      block_id: 'mb_table',
      type: 'table',
      content: {
        columns: [
          { key: 'month', label: '月份', dtype: 'string' },
          { key: 'sales_amount', label: '销售额（万）', dtype: 'number' },
          { key: 'growth', label: '环比', dtype: 'number' },
        ],
        rows: MONTHS.map((m, i) => ({
          month: m,
          sales_amount: SALES[i],
          growth: i === 0 ? '—' : Math.round((SALES[i] / SALES[i - 1] - 1) * 1000) / 10,
        })),
        total: 8,
        truncated: false,
      },
    }),
  )
  later((t += 260), () => emit('block_end', { block_id: 'mb_table', status: 'completed' }))

  // 4) 图表（M4 由 recharts 渲染，此处仅回放数据结构）
  later((t += 140), () =>
    emit('block_start', {
      block_id: 'mb_chart',
      type: 'chart',
      content: {
        chart_type: 'bar',
        title: '月度销售额趋势（2026·演示）',
        series: [{ name: '销售额（万）', x: MONTHS, y: SALES }],
        x_label: '月份',
        y_label: '销售额（万）',
        source_block_id: 'mb_table',
      },
    }),
  )
  later((t += 260), () => emit('block_end', { block_id: 'mb_chart', status: 'completed' }))

  // 5) 洞察
  later((t += 120), () =>
    emit('block_start', {
      block_id: 'mb_insights',
      type: 'insights',
      content: {
        items: [
          { title: '5 月为峰值', detail: '销售额 312 万，环比 +26.8%。', severity: 'positive' },
          { title: '8 月回落明显', detail: '环比下行，需关注季节性因素。', severity: 'warning' },
        ],
      },
    }),
  )
  later((t += 120), () => emit('block_end', { block_id: 'mb_insights', status: 'completed' }))

  // 6) 追问建议
  later((t += 120), () =>
    emit('block_start', {
      block_id: 'mb_suggestions',
      type: 'suggestions',
      content: {
        items: [
          { text: '按客户维度拆分', message: '请按客户维度拆分销售额' },
          { text: '对比去年同期', message: '请对比去年同期的销售额' },
          { text: '预测下月销售额', message: '请预测下个月的销售额' },
        ],
      },
    }),
  )
  later((t += 120), () => emit('block_end', { block_id: 'mb_suggestions', status: 'completed' }))

  // 7) done：携带用量后关闭流
  later(t, () => {
    emit('done', {
      usage: { total_tokens: 986, prompt_tokens: 210, completion_tokens: 776, model: 'mock' },
    })
    finish()
  })

  return await finished.then(() => true)
}