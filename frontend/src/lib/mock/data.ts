/**
 * Mock 种子数据与内存 store（VITE_USE_MOCK=true 时生效）。
 * 仅用于前端脱离后端演示；数据与 docs/Block与协议规范.md 第 1、2 章保持一致。
 * 注意：本文件是纯前端脚手架，不是后端契约。
 */
import type { Block, Message, SessionInfo } from '@/types/message'

function sid(prefix = 'sd_'): string {
  return prefix + crypto.randomUUID().slice(0, 8)
}

function secAgo(min: number): string {
  const d = new Date(Date.now() - min * 60_000)
  return d.toISOString()
}

function block(b: Omit<Block, 'id'> & { id?: string }): Block {
  return { id: b.id ?? sid('b_'), ...b }
}

// ---------- 月度销售（示例数据集） ----------
const MONTHS = ['1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月']
const SALES = [182, 205, 198, 246, 312, 289, 268, 231]
const GROWTH = [null, 12.6, -3.4, 24.2, 26.8, -7.4, -7.3, -13.8]

const sqlStat = `SELECT
  DATE_TRUNC('month', order_date) AS month,
  SUM(amount)                     AS sales_amount
FROM orders
WHERE order_date >= CURRENT_DATE - INTERVAL '8 month'
GROUP BY 1
ORDER BY 1;`

const salesTable: Message = {
  id: 'm_sales_1',
  session_id: 'sd_sales',
  role: 'user',
  metadata: {},
  created_at: secAgo(30),
  blocks: [{ id: 'b_sales_q', type: 'text', status: 'completed', content: { text: '按月份统计销售额趋势' } }],
}

const salesAnswer: Message = {
  id: 'm_sales_2',
  session_id: 'sd_sales',
  role: 'assistant',
  metadata: { usage: { total_tokens: 1240, prompt_tokens: 386, completion_tokens: 854, model: 'gpt-4o-mini' } },
  created_at: secAgo(29),
  blocks: [
    block({
      id: 'b_sales_text',
      type: 'text',
      status: 'completed',
      content: {
        text: '已按月份统计近 8 个月销售额。总体呈**先升后降**趋势：5 月达到峰值 312 万，6 月起连续回落。详见图表与下方明细。',
      },
    }),
    block({
      id: 'b_sales_sql',
      type: 'code',
      status: 'completed',
      content: {
        language: 'sql',
        code: sqlStat,
        editable: true,
        execution: { task_id: 't_1001', status: 'success', duration_ms: 212 },
      },
    }),
    block({
      id: 'b_sales_table',
      type: 'table',
      status: 'completed',
      content: {
        columns: [
          { key: 'month', label: '月份', dtype: 'string' },
          { key: 'sales_amount', label: '销售额（万）', dtype: 'number' },
          { key: 'growth', label: '环比', dtype: 'number' },
        ],
        rows: MONTHS.map((m, i) => ({
          month: m,
          sales_amount: SALES[i],
          growth: GROWTH[i] === null ? '—' : GROWTH[i],
        })),
        total: 8,
        truncated: false,
        query: sqlStat,
      },
    }),
    block({
      id: 'b_sales_chart',
      type: 'chart',
      status: 'completed',
      content: {
        chart_type: 'bar',
        title: '月度销售额趋势（2026）',
        series: [{ name: '销售额（万）', x: MONTHS, y: SALES }],
        x_label: '月份',
        y_label: '销售额（万）',
        source_block_id: 'b_sales_table',
        query: sqlStat,
      },
    }),
    block({
      id: 'b_sales_insights',
      type: 'insights',
      status: 'completed',
      content: {
        items: [
          { title: '5 月为峰值', detail: '销售额 312 万，环比 +26.8%。', severity: 'positive' },
          { title: '8 月回落明显', detail: '环比 -13.8%，需关注季节性因素。', severity: 'warning' },
          { title: '整体中枢抬升', detail: '3–5 月连续上行，中枢较年初上移约 20%。' },
        ],
      },
    }),
  ],
}

// ---------- 客户贡献率（示例数据集） ----------
const salesTrend: Message[] = [salesTable, salesAnswer]

const customerUser: Message = {
  id: 'm_cust_1',
  session_id: 'sd_customers',
  role: 'user',
  metadata: {},
  created_at: secAgo(120),
  blocks: [{ id: 'b_cust_q', type: 'text', status: 'completed', content: { text: '哪些客户贡献了大部分收入' } }],
}

const customerAnswer: Message = {
  id: 'm_cust_2',
  session_id: 'sd_customers',
  role: 'assistant',
  metadata: { usage: { total_tokens: 862, prompt_tokens: 240, completion_tokens: 622, model: 'gpt-4o-mini' } },
  created_at: secAgo(119),
  blocks: [
    block({
      id: 'b_cust_text',
      type: 'text',
      status: 'completed',
      content: {
        text: '收入呈明显集中效应：**Top 5 客户贡献约 58%** 营收。建议对头部客户加强服务投入，同时关注腰部客户增长空间。',
      },
    }),
    block({
      id: 'b_cust_table',
      type: 'table',
      status: 'completed',
      content: {
        columns: [
          { key: 'customer', label: '客户', dtype: 'string' },
          { key: 'revenue', label: '营收（万）', dtype: 'number' },
          { key: 'share', label: '占比', dtype: 'number' },
        ],
        rows: [
          { customer: '华晟科技', revenue: 486, share: '16.2%' },
          { customer: '奇点网络', revenue: 421, share: '14.0%' },
          { customer: '中航物流', revenue: 358, share: '11.9%' },
          { customer: '蓝海贸易', revenue: 289, share: '9.6%' },
          { customer: '远景能源', revenue: 191, share: '6.4%' },
          { customer: '其他', revenue: 1265, share: '42.0%' },
        ],
        total: 6,
        truncated: false,
      },
    }),
    block({
      id: 'b_cust_suggestions',
      type: 'suggestions',
      status: 'completed',
      content: {
        items: [
          { text: '头部客户近 3 个月贡献变化', message: '请分析头部客户近三个月的贡献变化' },
          { text: '如何提升腰部客户营收', message: '请给出腰部客户营收提升的建议' },
          { text: '按行业拆分客户收入', message: '请按行业拆分客户收入' },
        ],
      },
    }),
  ],
}

const customerFlow: Message[] = [customerUser, customerAnswer]

export const SESSION_SEED: SessionInfo[] = [
  { id: 'sd_sales', title: '月度销售趋势分析', created_at: secAgo(30), updated_at: secAgo(29) },
  { id: 'sd_customers', title: '客户贡献度分析', created_at: secAgo(120), updated_at: secAgo(119) },
]

export const MESSAGE_SEED: Record<string, Message[]> = {
  sd_sales: salesTrend,
  sd_customers: customerFlow,
}

// mutation（模块级内存 store，仅 mock 运行时生效）
export const store = {
  sessions: [...SESSION_SEED],
  messagesBySession: new Map<string, Message[]>(Object.entries(MESSAGE_SEED)),
}