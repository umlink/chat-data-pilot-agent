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

// ---------- 确认执行演示（示例数据集，mock 下走 /chat/execute） ----------
const confirmUser: Message = {
  id: 'm_confirm_1',
  session_id: 'sd_confirm',
  role: 'user',
  metadata: {},
  created_at: secAgo(5),
  blocks: [{ id: 'b_confirm_q', type: 'text', status: 'completed', content: { text: '删除 3 天前的重复订单数据' } }],
}

const confirmAnswer: Message = {
  id: 'm_confirm_2',
  session_id: 'sd_confirm',
  role: 'assistant',
  metadata: { usage: { total_tokens: 402, prompt_tokens: 96, completion_tokens: 306, model: 'gpt-4o-mini' } },
  created_at: secAgo(4),
  blocks: [
    block({
      id: 'b_confirm_1',
      type: 'confirmation',
      status: 'pending',
      content: {
        operation: 'execute_sql',
        title: '确认执行删除操作',
        description: '该语句将永久删除 3 条订单记录，危险等级：高。',
        sql: "DELETE FROM orders WHERE created_at < CURRENT_DATE - INTERVAL '3 day';",
        risk_level: 'high',
        confirmed: false,
      },
    }),
  ],
}

// ---------- 数据源（示例数据集） ----------
export interface MockDataSource {
  id: string
  name: string
  type: string
  config: Record<string, unknown>
  created_at: string
  updated_at: string
}

const mockDatasources: MockDataSource[] = [
  {
    id: 'ds_sales_pg',
    name: '生产订单库（PostgreSQL）',
    type: 'postgresql',
    config: { host: '10.0.4.12', port: 5432, database: 'orders', user: 'analyst', password: '******' },
    created_at: secAgo(60 * 24 * 7),
    updated_at: secAgo(60 * 24 * 2),
  },
  {
    id: 'ds_warehouse_mysql',
    name: '数仓汇总（MySQL）',
    type: 'mysql',
    config: { host: '10.0.4.20', port: 3306, database: 'dw', user: 'reader', password: '******' },
    created_at: secAgo(60 * 24 * 5),
    updated_at: secAgo(60 * 24 * 5),
  },
  {
    id: 'ds_finance_sqlite',
    name: '本地财务库（SQLite）',
    type: 'sqlite',
    config: { path: '/data/finance.db' },
    created_at: secAgo(60 * 24 * 3),
    updated_at: secAgo(60 * 24 * 1),
  },
]

const previewColumns = [
  { name: 'order_id', data_type: 'integer' },
  { name: 'order_date', data_type: 'timestamp without time zone' },
  { name: 'customer', data_type: 'character varying' },
  { name: 'amount', data_type: 'numeric' },
]
const previewRows = [
  { order_id: 10241, order_date: '2026-08-20T09:12:00', customer: '华晟科技', amount: '486000.00' },
  { order_id: 10242, order_date: '2026-08-21T14:03:00', customer: '奇点网络', amount: '210500.00' },
  { order_id: 10243, order_date: '2026-08-22T10:27:00', customer: '中航物流', amount: '158000.00' },
  { order_id: 10244, order_date: '2026-08-23T16:45:00', customer: '蓝海贸易', amount: '98000.00' },
]

// ---------- 配置（示例数据集） ----------
export const mockConfig: Record<string, Record<string, unknown>> = {
  'llm.provider': { provider: 'openai', model: 'gpt-4o', temperature: 0.5, max_tokens: 4096, timeout: 60, retry_count: 1, stream_enabled: true },
  'llm.openai': { api_key: '******', base_url: '', organization: '' },
  'llm.anthropic': { api_key: '******', base_url: '', version: '2023-06-01' },
  'system.query': { max_query_rows: 1000 },
  'system.task': { timeout_seconds: 300, max_concurrency: 3 },
  'system.upload': { max_size_mb: 20 },
  'system.session': { retention_days: 30 },
  'system.sql': { safe_mode: 'normal' },
  'system.log': { retention_days: 30 },
}

// ---------- 日志（示例数据集） ----------
export interface MockLogRow {
  id: string
  timestamp: string
  level: string
  category: string
  message: string
  context: Record<string, unknown>
}

function logRow(id: string, minutesAgo: number, level: string, category: string, message: string, context: Record<string, unknown> = {}): MockLogRow {
  return { id, timestamp: secAgo(minutesAgo), level, category, message, context }
}

const mockLogs: MockLogRow[] = [
  logRow('lg_01', 42, 'INFO', 'application', '用户登录', { user: 'admin', resource: 'auth', action: 'login' }),
  logRow('lg_02', 41, 'INFO', 'application', '会话已创建', { user: 'admin', resource: 'session' }),
  logRow('lg_03', 40, 'INFO', 'ai', 'LLM 请求完成', { model: 'deepseek-chat', tokens: 1240, latency_ms: 2480 }),
  logRow('lg_04', 39, 'DEBUG', 'system', '配置缓存命中', { key: 'config:all' }),
  logRow('lg_05', 35, 'WARNING', 'application', '数据源连接超时', { datasource: '数仓汇总（MySQL）' }),
  logRow('lg_06', 30, 'INFO', 'ai', 'SQL 执行', { session_id: 'sd_sales', latency_ms: 212, rows: 8 }),
  logRow('lg_07', 28, 'ERROR', 'error', 'SQL 执行失败：关系不存在', { sql: 'SELECT * FROM order' }),
  logRow('lg_08', 25, 'INFO', 'audit', '配置变更: llm.provider', { user: 'admin', resource: 'config', action: 'update' }),
  logRow('lg_09', 22, 'INFO', 'application', '附件上传', { user: 'admin', resource: 'attachment', action: 'create' }),
  logRow('lg_10', 21, 'INFO', 'system', '任务已创建', { type: 'file_parse' }),
  logRow('lg_11', 20, 'CRITICAL', 'error', '工作线程异常退出', { worker: 'w-1' }),
  logRow('lg_12', 18, 'INFO', 'ai', 'SQL 执行', { session_id: 'sd_sales', latency_ms: 168, rows: 6 }),
  logRow('lg_13', 15, 'WARNING', 'system', 'Redis 连接失败，降级', { host: 'redis.internal' }),
  logRow('lg_14', 12, 'INFO', 'application', '数据源连接测试通过', { datasource: '生产订单库（PostgreSQL）', server_version: '17.0.4' }),
  logRow('lg_15', 9, 'INFO', 'ai', 'LLM 请求完成', { model: 'deepseek-chat', tokens: 862, latency_ms: 1902 }),
  logRow('lg_16', 6, 'ERROR', 'error', '登录尝试过于频繁', { ip: '*.*.*.12' }),
  logRow('lg_17', 3, 'INFO', 'audit', '导出表格 CSV', { user: 'admin', resource: 'export', action: 'create' }),
  logRow('lg_18', 1, 'INFO', 'application', '用户登录', { user: 'admin', resource: 'auth', action: 'login' }),
]

// ---------- LLM 供应商（与 backend/app/api/llm_providers.py 契约一致） ----------
export interface MockLlmProvider {
  id: string
  name: string
  type: 'openai' | 'anthropic'
  base_url: string
  api_key: string
  models: string[]
  default_model: string
  is_default: boolean
  created_at: string
  updated_at: string
}

const mockLlmProviders: MockLlmProvider[] = [
  {
    id: 'lp_deepseek',
    name: 'DeepSeek 主力',
    type: 'openai',
    base_url: 'https://api.deepseek.com/v1',
    api_key: '******',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    default_model: 'deepseek-chat',
    is_default: true,
    created_at: secAgo(60 * 24 * 3),
    updated_at: secAgo(60 * 24),
  },
  {
    id: 'lp_anthropic',
    name: 'Anthropic 备用',
    type: 'anthropic',
    base_url: 'https://api.anthropic.com',
    api_key: '******',
    models: ['claude-sonnet-4-5'],
    default_model: 'claude-sonnet-4-5',
    is_default: false,
    created_at: secAgo(60 * 24 * 2),
    updated_at: secAgo(60 * 24 * 2),
  },
]

// mutation（模块级内存 store，仅 mock 运行时生效）
export const store = {
  sessions: [...SESSION_SEED, { id: 'sd_confirm', title: '确认执行演示', created_at: secAgo(5), updated_at: secAgo(4) }],
  messagesBySession: new Map<string, Message[]>([...Object.entries(MESSAGE_SEED), ['sd_confirm', [confirmUser, confirmAnswer]]]),
  datasources: [...mockDatasources],
  configs: { ...mockConfig },
  logs: [...mockLogs],
  llmProviders: [...mockLlmProviders],
  preview: { table_schema: 'public', table: 'orders', columns: previewColumns, rows: previewRows, count: previewRows.length, truncated: false },
}

// 供 handlers 引用：确认演示会话（mock 下 /chat/execute 可决策该卡片）
export const CONFIRM_BLOCK_ID = 'b_confirm_1'