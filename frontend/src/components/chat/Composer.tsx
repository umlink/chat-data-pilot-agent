import { useRef, useState } from 'react'
import { AtSign, FileText, Loader2, Paperclip, Send } from 'lucide-react'
import { useAttachments } from '@/hooks/useAttachments'
import { useChatStore } from '@/store/chatStore'
import type { Template } from '@/types/template'
import { DatasourcePicker } from './DatasourcePicker'
import { TemplatePickerDialog } from './TemplatePickerDialog'

interface Props {
  sessionId: string
  disabled: boolean
  onSend: (text: string) => void
}

/** 数据类问题启发式关键词：命中 + 未选数据源时提示用户选择（不阻塞发送） */
const DATA_KEYWORDS = [
  '统计', '查询', '分析', '趋势', '占比', '销售额', '客户', '数据', '表',
  '报表', '对比', '筛选', '汇总', '订单', '销量', '利润', '指标', '图表',
  '明细', '平均', '最高', '最低', '多少', '几个', '哪些',
]

/** 输入区 Composer（docs/UI设计规范.md 3.12）：文本 + 附件上传 + 上下文数据源选择 */
export function Composer({ sessionId, disabled, onSend }: Props) {
  const [text, setText] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const { uploading, error: uploadError, uploadFiles } = useAttachments()
  const selectedDs = useChatStore((s) => s.datasourceBySession[sessionId] ?? '')

  const submit = () => {
    const t = text.trim()
    if (!t || disabled) return
    onSend(t)
    setText('')
  }

  const pickFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    void uploadFiles(Array.from(files))
    // 清空 value 允许重复选择同一文件
    if (fileRef.current) fileRef.current.value = ''
  }

  /** 模板「使用」：SQL 回填输入框（可编辑后发送）；数据源联动在 TemplatePickerDialog.pick 处理 */
  const applyTemplate = (t: Template) => {
    const sql = (t.sql_text ?? '').trim()
    setText(sql || `请使用模板「${t.name}」${t.description ? `：${t.description}` : ''}`)
    setTemplateOpen(false)
  }

  // 数据类问题且未指定数据源 → 展示建议提示（仅提示，不拦截发送）
  const trimmed = text.trim()
  const showDsHint =
    trimmed.length > 0 &&
    !selectedDs &&
    !disabled &&
    DATA_KEYWORDS.some((k) => trimmed.includes(k))

  return (
    <div className="shrink-0 border-t bg-background px-6 py-3 print:hidden">
      <div className="flex items-end gap-2 rounded-xl border border-input bg-background p-2 transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15">
        <div className="flex items-center gap-0.5">
          <DatasourcePicker
            sessionId={sessionId}
            disabled={disabled}
            open={pickerOpen}
            onOpenChange={setPickerOpen}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={disabled || uploading}
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="添加附件"
            title="添加附件"
          >
            {uploading ? <Loader2 size={15} className="animate-spin" /> : <Paperclip size={15} />}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls,.json"
            multiple
            className="hidden"
            onChange={(e) => pickFiles(e.target.files)}
          />
          <button
            onClick={() => setTemplateOpen(true)}
            disabled={disabled}
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="使用模板"
            title="使用模板"
          >
            <FileText size={15} />
          </button>
          <button
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="提及数据集"
            title="提及数据集（待开放）"
          >
            <AtSign size={15} />
          </button>
        </div>
        <textarea
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="输入您的问题，Shift+Enter 换行…"
          className="max-h-[120px] min-h-[22px] flex-1 resize-none bg-transparent px-1 py-1.5 text-[13px] leading-[1.5] text-foreground outline-none placeholder:text-muted-foreground"
        />
        <button
          onClick={submit}
          disabled={disabled || !text.trim()}
          aria-label="发送"
          className="btn-send disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Send size={15} />
        </button>
      </div>
      {uploadError ? (
        <div className="mt-1.5 text-center text-[11px] text-error" role="alert">
          {uploadError}
        </div>
      ) : null}
      {showDsHint ? (
        <div className="mt-1.5 flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
          <span>检测到数据类问题，建议指定数据源以获得更准确定位</span>
          <button
            onClick={() => setPickerOpen(true)}
            className="rounded-md border px-1.5 py-0.5 text-primary hover:bg-accent"
          >
            选择数据源
          </button>
        </div>
      ) : null}
      <div className="mt-1.5 text-center text-[11px] text-muted-foreground">
        Enter 发送 · Shift+Enter 换行 · @ 提及数据集
      </div>

      <TemplatePickerDialog
        open={templateOpen}
        onOpenChange={setTemplateOpen}
        onPick={applyTemplate}
      />
    </div>
  )
}
