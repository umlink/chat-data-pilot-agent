import { create } from 'zustand'

/** 数据源出参（镜像 backend/app/schemas/datasource.py DatasourceOut；config 敏感字段已掩码）。 */
export interface DataSourceInfo {
  id: string
  name: string
  type: string
  config: Record<string, unknown>
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
