/**
 * Mock REST 路由（VITE_USE_MOCK=true 时由 api.ts 的 request() 先路由到此处）。
 * 命中返回数据；未命中返回 undefined，由调用方回落到真实 fetch。
 */
import type { Message, SessionInfo } from '@/types/message'
import { store } from './data'

type MockBody = Record<string, unknown> | undefined
type Method = 'GET' | 'POST'

// 与 backend/app/schemas/datasource.py SECRET_CONFIG_FIELDS 对齐（mock 出参掩码用）
const SECRET_KEYS = ['password', 'token', 'secret', 'api_key', 'access_key', 'secret_key']

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 序列化为 Message 形状（后端 _serialize_message 的 mock 等价） */
function serialize(msg: Message): Message {
  return {
    id: msg.id,
    session_id: msg.session_id,
    role: msg.role,
    blocks: copy(msg.blocks),
    metadata: { ...msg.metadata },
    created_at: msg.created_at,
  }
}

/** 未命中返回 undefined，代表该请求按真实路径发起 */
export async function mockRequest(
  path: string,
  method: Method,
  body: MockBody,
): Promise<unknown | undefined> {
  // 模拟网络延迟（180–420ms）
  await sleep(180 + Math.random() * 240)

  // 登录：mock 接受任意非空账号，返回虚拟 token
  if (method === 'POST' && path === '/auth/login') {
    const username = String((body as { username?: unknown } | undefined)?.username ?? 'admin')
    return {
      token: `mock-token-${Math.random().toString(16).slice(2)}`,
      user: { username },
    }
  }

  // 会话列表（返回拷贝，避免外部持有内部引用导致状态被变异污染）
  if (method === 'GET' && path === '/sessions') {
    return [...store.sessions]
  }

  // 新建会话（不可变地构造新数组，不用 in-place unshift）
  if (method === 'POST' && path === '/sessions') {
    const title = String((body as { title?: unknown } | undefined)?.title ?? '新对话')
    const s: SessionInfo = {
      id: `sd_${Math.random().toString(16).slice(2, 10)}`,
      title,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    store.sessions = [s, ...store.sessions]
    store.messagesBySession.set(s.id, [])
    return s
  }

  // 会话下消息（拷贝）
  const msgMatch = path.match(/^\/sessions\/([^/]+)\/messages$/)
  if (method === 'GET' && msgMatch) {
    return [...(store.messagesBySession.get(msgMatch[1]) ?? [])]
  }

  // 删除会话
  if (method === 'POST' && path === '/sessions/delete') {
    const id = String((body as { id?: unknown } | undefined)?.id ?? '')
    store.sessions = store.sessions.filter((s) => s.id !== id)
    store.messagesBySession.delete(id)
    return { ok: true }
  }

  // ---------- 数据源（与 backend/app/api/datasources.py 契约一致） ----------
  // 敏感字段出参掩码（mock 内存存明文，仅演示掩码行为）
  const maskConfig = (cfg: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(cfg).map(([k, v]) => [
        k,
        SECRET_KEYS.includes(k) && typeof v === 'string' && v ? '******' : v,
      ]),
    )

  if (method === 'GET' && path === '/datasources') {
    return store.datasources.map((d) => ({ ...d, config: maskConfig(d.config) }))
  }
  if (method === 'POST' && path === '/datasources/test') {
    const type = String((body as { type?: unknown } | undefined)?.type ?? '')
    if (type === 'csv' || type === 'excel' || type === 'json') {
      return { ok: false, error: '文件型数据源请通过附件上传导入' }
    }
    return { ok: true, server_version: type === 'postgresql' ? '17.0.4' : '8.4.0 (mock)' }
  }
  if (method === 'POST' && path === '/datasources') {
    const raw = body as { name?: unknown; type?: unknown; config?: Record<string, unknown> } | undefined
    const ds = {
      id: `ds_${Math.random().toString(16).slice(2, 10)}`,
      name: String(raw?.name ?? '未命名'),
      type: String(raw?.type ?? 'postgresql'),
      config: raw?.config ?? {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    store.datasources = [ds, ...store.datasources]
    return { ...ds, config: maskConfig(ds.config) }
  }
  if (method === 'POST' && path === '/datasources/update') {
    const raw = body as { id?: unknown; name?: unknown; type?: unknown; config?: Record<string, unknown> } | undefined
    const id = String(raw?.id ?? '')
    store.datasources = store.datasources.map((d) => {
      if (d.id !== id) return d
      return {
        ...d,
        name: raw?.name !== undefined ? String(raw.name) : d.name,
        type: raw?.type !== undefined ? String(raw.type) : d.type,
        config: raw?.config !== undefined ? { ...d.config, ...raw.config } : d.config,
        updated_at: new Date().toISOString(),
      }
    })
    const found = store.datasources.find((d) => d.id === id)
    return found ? { ...found, config: maskConfig(found.config) } : found
  }
  if (method === 'POST' && path === '/datasources/delete') {
    const id = String((body as { id?: unknown } | undefined)?.id ?? '')
    store.datasources = store.datasources.filter((d) => d.id !== id)
    return { ok: true }
  }
  const previewMatch = path.match(/^\/datasources\/([^/]+)\/preview$/)
  if (method === 'GET' && previewMatch) {
    return { datasource_id: previewMatch[1], ...copy(store.preview) }
  }
  const schemaMatch = path.match(/^\/datasources\/([^/]+)\/schema$/)
  if (method === 'GET' && schemaMatch) {
    return {
      datasource_id: schemaMatch[1],
      datasource_type: 'postgresql',
      tables: [
        {
          schema: 'public',
          name: 'orders',
          comment: '订单表',
          columns: [
            { name: 'id', data_type: 'bigint', comment: null, is_nullable: false },
            { name: 'customer', data_type: 'text', comment: '客户', is_nullable: true },
            { name: 'amount', data_type: 'numeric', comment: '金额', is_nullable: true },
            { name: 'created_at', data_type: 'timestamp', comment: null, is_nullable: true },
          ],
          sample: [{ id: 1, customer: '张三', amount: 12.5, created_at: '2026-08-01' }],
        },
        {
          schema: 'public',
          name: 'products',
          comment: null,
          columns: [
            { name: 'sku', data_type: 'text', comment: null, is_nullable: false },
            { name: 'price', data_type: 'numeric', comment: null, is_nullable: true },
          ],
          sample: [{ sku: 'A-1', price: 9.9 }],
        },
      ],
    }
  }

  // ---------- 配置（与 backend/app/api/config.py 契约一致：扁平 key → valueDict） ----------
  if (method === 'GET' && path === '/config') {
    return { ...store.configs }
  }
  if (method === 'POST' && path === '/config/update') {
    const updates = (body as { updates?: Record<string, Record<string, unknown>> } | undefined)?.updates ?? {}
    for (const [key, fields] of Object.entries(updates)) {
      const current = store.configs[key] ?? {}
      const merged: Record<string, unknown> = { ...current }
      for (const [field, value] of Object.entries(fields)) {
        // 空串（含掩码保留语义）不覆盖旧值
        if (value === '') continue
        merged[field] = value
      }
      store.configs[key] = merged
    }
    return { ...store.configs }
  }
  if (method === 'POST' && path === '/config/test') {
    const provider = store.configs['llm.provider']
    return { ok: true, model: String(provider?.model ?? 'mock'), latency_ms: 96 }
  }

  // ---------- 日志（与 backend/app/api/logs.py 契约一致：分页查询，query 在 URL 上） ----------
  const logsMatch = path.match(/^\/logs(?:\?(.*))?$/)
  if (method === 'GET' && logsMatch) {
    const sp = new URLSearchParams(logsMatch[1] ?? '')
    const category = sp.get('category') ?? ''
    const level = (sp.get('level') ?? '').toUpperCase()
    const keyword = sp.get('keyword') ?? ''
    const page = Number(sp.get('page') ?? 1)
    const pageSize = Number(sp.get('page_size') ?? 20)
    const filtered = store.logs.filter(
      (l) =>
        (!category || l.category === category) &&
        (!level || l.level === level) &&
        (!keyword || l.message.includes(keyword)),
    )
    const items = filtered.slice((page - 1) * pageSize, page * pageSize)
    return { items: items.map((l) => ({ ...l })), total: filtered.length, page, page_size: pageSize }
  }

  // ---------- 确认决策（与 backend/app/api/chat.py /chat/execute 契约一致） ----------
  if (method === 'POST' && path === '/chat/execute') {
    const raw = body as { block_id?: unknown; decision?: unknown; sql?: unknown } | undefined
    const blockId = String(raw?.block_id ?? '')
    const decision = String(raw?.decision ?? '')
    const messages = store.messagesBySession.get('sd_confirm') ?? []
    const msg = messages.find((m) => m.blocks.some((b) => b.id === blockId))
    if (!msg) {
      throw new Error('确认卡片不存在或已处理')
    }
    const blocks = msg.blocks.map((b) => (b.id === blockId ? { ...b } : b))

    for (const b of blocks) {
      if (b.id !== blockId) continue
      if (decision === 'cancel') {
        b.status = 'rejected'
        b.content = { ...b.content, confirmed: false }
      } else {
        b.status = 'completed'
        b.content = {
          ...b.content,
          confirmed: true,
          result_block_id: `b_result_${Math.random().toString(16).slice(2, 8)}`,
        }
        const resultBlock = {
          id: b.content.result_block_id as string,
          type: 'table' as const,
          status: 'completed' as const,
          parent_block_id: blockId,
          content: {
            columns: [
              { key: 'order_id', label: '订单号', dtype: 'number' },
              { key: 'order_date', label: '下单时间', dtype: 'date' },
              { key: 'customer', label: '客户', dtype: 'string' },
              { key: 'amount', label: '金额（元）', dtype: 'number' },
            ],
            rows: [
              { order_id: 10001, order_date: '2026-08-01T09:00:00', customer: '华晟科技', amount: '128000.00' },
              { order_id: 10002, order_date: '2026-08-02T11:30:00', customer: '奇点网络', amount: '56000.00' },
              { order_id: 10003, order_date: '2026-08-03T15:10:00', customer: '中航物流', amount: '78000.00' },
            ],
            total: 3,
            truncated: false,
            query: String(raw?.sql ?? b.content.sql ?? ''),
          },
        }
        blocks.push(resultBlock)
      }
    }
    const updated = { ...msg, blocks } as Message
    store.messagesBySession.set('sd_confirm', messages.map((m) => (m.id === msg.id ? updated : m)))
    return { message: serialize(updated), result_block_id: blocks[blocks.length - 1]?.content.result_block_id }
  }

  // ---------- LLM 供应商（与 backend/app/api/llm_providers.py 契约一致） ----------
  if (method === 'GET' && path === '/llm/providers') {
    return [...store.llmProviders].sort((a, b) => Number(b.is_default) - Number(a.is_default))
  }
  if (method === 'POST' && path === '/llm/providers') {
    const raw = body as { name?: unknown; type?: unknown; base_url?: unknown; api_key?: unknown; models?: unknown; default_model?: unknown } | undefined
    const models = Array.isArray(raw?.models) ? raw.models.map(String) : []
    const default_model = String(raw?.default_model ?? models[0] ?? '')
    const firstAbsent = store.llmProviders.length === 0
    const p = {
      id: `lp_${Math.random().toString(16).slice(2, 10)}`,
      name: String(raw?.name ?? '未命名'),
      type: (raw?.type === 'anthropic' ? 'anthropic' : 'openai') as 'openai' | 'anthropic',
      base_url: String(raw?.base_url ?? ''),
      api_key: String(raw?.api_key ?? ''),
      models,
      default_model,
      is_default: firstAbsent, // 首个自动为默认
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    store.llmProviders = [p, ...store.llmProviders]
    return { ...p, api_key: p.api_key ? '******' : '' }
  }
  if (method === 'POST' && path === '/llm/providers/update') {
    const raw = body as { id?: unknown; name?: unknown; type?: unknown; base_url?: unknown; api_key?: unknown; models?: unknown; default_model?: unknown } | undefined
    const id = String(raw?.id ?? '')
    store.llmProviders = store.llmProviders.map((p) => {
      if (p.id !== id) return p
      const models = Array.isArray(raw?.models) ? raw.models.map(String) : p.models
      return {
        ...p,
        name: raw?.name !== undefined ? String(raw.name) : p.name,
        type: raw?.type === 'anthropic' ? 'anthropic' : raw?.type === 'openai' ? 'openai' : p.type,
        base_url: raw?.base_url !== undefined ? String(raw.base_url) : p.base_url,
        // 掩码/空串 = 保留旧值
        api_key: typeof raw?.api_key === 'string' && raw.api_key && raw.api_key !== '******' ? raw.api_key : p.api_key,
        models,
        default_model: raw?.default_model !== undefined ? String(raw.default_model) : p.default_model,
        updated_at: new Date().toISOString(),
      }
    })
    const found = store.llmProviders.find((p) => p.id === id)
    return found ? { ...found } : found
  }
  if (method === 'POST' && path === '/llm/providers/delete') {
    const id = String((body as { id?: unknown } | undefined)?.id ?? '')
    const removed = store.llmProviders.find((p) => p.id === id)
    store.llmProviders = store.llmProviders.filter((p) => p.id !== id)
    // 删除默认项时自动提升最近更新的一项
    if (removed?.is_default && store.llmProviders.length > 0) {
      const successor = [...store.llmProviders].sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      )[0]
      store.llmProviders = store.llmProviders.map((p) => (p.id === successor.id ? { ...p, is_default: true } : p))
    }
    return { ok: true }
  }
  const setDefaultMatch = path.match(/^\/llm\/providers\/([^/]+)\/set-default$/)
  if (method === 'POST' && setDefaultMatch) {
    const id = setDefaultMatch[1]
    store.llmProviders = store.llmProviders.map((p) => ({ ...p, is_default: p.id === id }))
    const found = store.llmProviders.find((p) => p.id === id)
    return found ? { ...found } : found
  }
  const testMatch = path.match(/^\/llm\/providers\/([^/]+)\/test$/)
  if (method === 'POST' && testMatch) {
    const p = store.llmProviders.find((x) => x.id === testMatch[1])
    if (!p) return { ok: false, error: '供应商不存在' }
    if (!p.api_key || p.api_key === '******') return { ok: false, error: '未配置 API Key，请在配置页填写后保存' }
    if (p.type === 'anthropic') return { ok: false, error: 'Anthropic 协议测试将在 LLM 适配器（M2）就绪后支持' }
    return { ok: true, model: p.default_model || 'mock', latency_ms: 132 }
  }

  return undefined
}