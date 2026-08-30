import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import type { DataSourceInfo } from '@/store/dataSourceStore'

const MAX_PROMPTS = 10
const MAX_LEN = 100

interface Props {
  /** 目标数据源；null 时抽屉关闭 */
  ds: DataSourceInfo | null
  onClose: () => void
  /** 保存成功后回调（列表页刷新 + store 同步） */
  onSaved: () => void
}

/** 快捷文案管理抽屉：逐条增删改，保存走 POST /datasources/update（整体替换）。 */
export function DatasourcePromptsDrawer({ ds, onClose, onSaved }: Props) {
  const [prompts, setPrompts] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // 打开时以数据源当前文案初始化（ds 引用变化即重新初始化）
  useEffect(() => {
    if (ds) {
      setPrompts([...(ds.quick_prompts ?? [])])
      setDraft('')
      setError('')
    }
  }, [ds])

  const add = () => {
    const t = draft.trim()
    if (!t) return
    if (t.length > MAX_LEN) {
      setError(`单条快捷文案不能超过 ${MAX_LEN} 字`)
      return
    }
    if (prompts.length >= MAX_PROMPTS) {
      setError(`快捷文案最多 ${MAX_PROMPTS} 条`)
      return
    }
    if (prompts.some((p) => p === t)) {
      setError('该文案已存在')
      return
    }
    setPrompts([...prompts, t])
    setDraft('')
    setError('')
  }

  const remove = (i: number) => {
    setPrompts(prompts.filter((_, idx) => idx !== i))
  }

  const save = async () => {
    if (!ds) return
    // 去重与长度兜底（正常不会触发，防御粘贴场景）
    const cleaned = [...new Set(prompts.map((p) => p.trim()).filter(Boolean))]
    if (cleaned.some((p) => p.length > MAX_LEN)) {
      setError(`单条快捷文案不能超过 ${MAX_LEN} 字`)
      return
    }
    if (cleaned.length > MAX_PROMPTS) {
      setError(`快捷文案最多 ${MAX_PROMPTS} 条`)
      return
    }
    setSaving(true)
    setError('')
    try {
      await api.post('/datasources/update', { id: ds.id, quick_prompts: cleaned })
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer open={ds !== null} onOpenChange={(open) => !open && onClose()}>
      <DrawerContent className="p-0">
        <DrawerHeader>
          <DrawerTitle>快捷文案 — {ds?.name ?? ''}</DrawerTitle>
          <DrawerDescription>
            对话中选中「{ds?.name ?? ''}」时，输入框上方将展示这些文案，点击即可填入输入框
          </DrawerDescription>
        </DrawerHeader>

        <DrawerBody className="space-y-3">
          <div className="flex items-center gap-2">
            <Input
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                setError('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  add()
                }
              }}
              placeholder="输入文案后回车添加，如：查最近 7 天订单趋势"
              aria-label="新增快捷文案"
              maxLength={MAX_LEN}
            />
            <Button size="sm" onClick={add} disabled={!draft.trim() || prompts.length >= MAX_PROMPTS}>
              <Plus /> 添加
            </Button>
          </div>

          {prompts.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
              暂无快捷文案，添加后可在对话输入区快速填入
            </p>
          ) : (
            <ul className="space-y-1.5">
              {prompts.map((p, i) => (
                <li key={`${i}-${p}`} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5">
                  <span className="flex-1 truncate text-[13px] text-foreground" title={p}>
                    {p}
                  </span>
                  <button
                    onClick={() => remove(i)}
                    aria-label={`删除文案：${p}`}
                    className="rounded-md p-2 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {error ? (
            <p className="text-xs text-error" role="alert">
              {error}
            </p>
          ) : null}
        </DrawerBody>

        <DrawerFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}
