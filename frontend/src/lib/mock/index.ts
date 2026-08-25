/**
 * Mock 层统一出口。
 * VITE_USE_MOCK=true（见 .env.development）时，api.ts 的 request() 与
 * sseClient.ts 的 streamSSE() 先路由到 lib/mock，实现脱离后端可演示。
 */
export const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK === 'true'

export { mockRequest } from './handlers'
export { mockStream } from './stream'