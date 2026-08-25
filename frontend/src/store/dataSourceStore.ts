import { create } from 'zustand'

export interface DataSourceInfo {
  id: string
  name: string
  type: string
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