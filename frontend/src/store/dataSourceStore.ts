import { create } from 'zustand'

/** 数据源出参（镜像 backend/app/schemas/datasource.py DatasourceOut；config 敏感字段已掩码）。 */
export interface DataSourceInfo {
  id: string
  name: string
  type: string
  config: Record<string, unknown>
  /** 连接状态（PRD 3.2.3）：手动测试与后台心跳写回 */
  status?: 'unknown' | 'ok' | 'error'
  last_checked_at?: string | null
  last_error?: string | null
  server_version?: string | null
  /** 快捷文案：对话输入区选中该数据源时横条展示（最多 10 条） */
  quick_prompts?: string[]
  created_at?: string | null
  updated_at?: string | null
}

interface DataSourceState {
  list: DataSourceInfo[]
  currentId: string | null
  /** 是否显示数据源管理页面 */
  showManager: boolean
  setList: (list: DataSourceInfo[]) => void
  setCurrent: (id: string | null) => void
  setShowManager: (v: boolean) => void
}

export const useDataSourceStore = create<DataSourceState>((set) => ({
  list: [],
  currentId: null,
  showManager: false,
  setList: (list) => set({ list }),
  setCurrent: (currentId) => set({ currentId }),
  setShowManager: (showManager) => set({ showManager }),
}))
