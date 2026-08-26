import { useRef, useState } from 'react'
import { AtSign, Loader2, Paperclip, Send } from 'lucide-react'
import { useAttachments } from '@/hooks/useAttachments'

interface Props {
  disabled: boolean
  onSend: (text: string) => void
}

/** 输入区 Composer（docs/UI设计规范.md 3.12）：文本 + 附件上传（草稿区在 AttachmentDrafts） */
export function Composer({ disabled, onSend }: Props) {
  const [text, setText] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const { uploading, error: uploadError, uploadFiles } = useAttachments()

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

  return (
    <div className="shrink-0 border-t bg-background px-6 py-3">
      <div className="flex items-end gap-2 rounded-xl border border-input bg-background p-2 transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15">
        <div className="flex items-center gap-0.5">
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
      <div className="mt-1.5 text-center text-[11px] text-muted-foreground">
        Enter 发送 · Shift+Enter 换行 · @ 提及数据集
      </div>
    </div>
  )
}
