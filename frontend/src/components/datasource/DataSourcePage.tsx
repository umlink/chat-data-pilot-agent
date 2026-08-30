import { useCallback, useEffect, useState } from 'react'
import { Database, Plus } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { useDataSourceStore, type DataSourceInfo } from '@/store/dataSourceStore'
import { type TestResult } from './constants'
import { DataSourceFormDialog } from './DataSourceFormDialog'
import { DataSourcePreviewDialog } from './DataSourcePreviewDialog'
import { DatasourcePromptsDrawer } from './DatasourcePromptsDrawer'
import { DataSourceSchemaDialog } from './DataSourceSchemaDialog'
import { DataSourceTable, type TestState } from './DataSourceTable'

/** 数据源管理页：列表 + 新建/编辑/测试连接/预览/删除（backend/app/api/datasources.py）。 */
export function DataSourcePage() {
  const setStoreList = useDataSourceStore((s) => s.setList)
  const [list, setList] = useState<DataSourceInfo[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<DataSourceInfo | null>(null)
  const [previewDs, setPreviewDs] = useState<DataSourceInfo | null>(null)
  const [schemaDs, setSchemaDs] = useState<DataSourceInfo | null>(null)
  const [promptsDs, setPromptsDs] = useState<DataSourceInfo | null>(null)
  const [deleteDs, setDeleteDs] = useState<DataSourceInfo | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [testMap, setTestMap] = useState<Record<string, TestState>>({})

  const load = useCallback(async () => {
    try {
      const data = await api.get<DataSourceInfo[]>('/datasources')
      setList(data)
      setLoadError('')
      setStoreList(data)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '数据源列表加载失败')
    }
  }, [setStoreList])

  useEffect(() => {
    let alive = true
    void api
      .get<DataSourceInfo[]>('/datasources')
      .then((data) => {
        if (!alive) return
        setList(data)
        setLoadError('')
        setStoreList(data)
      })
      .catch((e) => {
        if (alive) setLoadError(e instanceof Error ? e.message : '数据源列表加载失败')
      })
    return () => {
      alive = false
    }
  }, [setStoreList])

  const openCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }

  const openEdit = (ds: DataSourceInfo) => {
    setEditing(ds)
    setFormOpen(true)
  }

  const testConnection = async (ds: DataSourceInfo) => {
    setTestMap((m) => ({ ...m, [ds.id]: 'loading' }))
    try {
      // 按 id 测试：服务端解密库中密文配置（列表 config 是掩码，不能用于测试）。
      // 测试结果会写回数据源 status/last_checked_at，刷新列表以更新状态徽标。
      const r = await api.post<TestResult>(`/datasources/${ds.id}/test`)
      setTestMap((m) => ({ ...m, [ds.id]: r }))
      void load()
    } catch (e) {
      setTestMap((m) => ({ ...m, [ds.id]: { ok: false, error: e instanceof Error ? e.message : '连接测试失败' } }))
      void load()
    }
  }

  const confirmDelete = async () => {
    if (!deleteDs) return
    setDeleting(true)
    setDeleteError('')
    try {
      await api.post('/datasources/delete', { id: deleteDs.id })
      setDeleteDs(null)
      void load()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-6 pb-1 pt-6">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground">数据源管理</h2>
          <p className="text-xs text-muted-foreground">
            连接 PostgreSQL / MySQL / SQLite；CSV / Excel / JSON 文件型数据源通过聊天区附件上传导入
          </p>
        </div>
        <Button size="lg" onClick={openCreate}>
          <Plus /> 新建数据源
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 px-6 pb-6 pt-4">
        {loadError && (
          <div className="flex items-center justify-between rounded-lg border border-error/30 bg-error-bg px-4 py-3">
            <p className="text-xs text-error">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </div>
        )}

        {list === null && !loadError && (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        )}

        {list !== null && list.length === 0 && !loadError && (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              <Database size={18} />
            </div>
            <p className="text-[13px] text-muted-foreground">
              暂无数据源，点击右上角「新建数据源」创建第一个连接
            </p>
          </div>
        )}

        {list !== null && list.length > 0 && (
          <DataSourceTable
            list={list}
            testMap={testMap}
            onTest={(ds) => void testConnection(ds)}
            onPreview={setPreviewDs}
            onSchema={setSchemaDs}
            onPrompts={setPromptsDs}
            onEdit={openEdit}
            onDelete={(ds) => {
              setDeleteDs(ds)
              setDeleteError('')
            }}
          />
        )}
      </div>

      <DataSourceFormDialog
        open={formOpen}
        editing={editing}
        onOpenChange={(open) => {
          setFormOpen(open)
          if (!open) setEditing(null)
        }}
        onSaved={() => void load()}
      />

      <DataSourcePreviewDialog ds={previewDs} onClose={() => setPreviewDs(null)} />
      <DataSourceSchemaDialog ds={schemaDs} onClose={() => setSchemaDs(null)} />
      <DatasourcePromptsDrawer
        ds={promptsDs}
        onClose={() => setPromptsDs(null)}
        onSaved={() => void load()}
      />

      <Dialog
        open={deleteDs !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteDs(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除数据源</DialogTitle>
            <DialogDescription>确定删除「{deleteDs?.name ?? ''}」吗？删除后不可恢复。</DialogDescription>
          </DialogHeader>
          {deleteError && <p className="text-xs text-error">{deleteError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDs(null)} disabled={deleting}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting ? '删除中…' : '删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
