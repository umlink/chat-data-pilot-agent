import { useState } from 'react'
import { AtSign, Paperclip, Send } from 'lucide-react'

interface Props {
  disabled: boolean
  onSend: (text: string) => void
}

/** 输入区 Composer（docs/UI设计规范.md 3.12） */
export function Composer({ disabled, onSend }: Props) {
  const [text, setText] = useState('')

  const submit = () => {
    const t = text.trim()
    if (!t || disabled) return
    onSend(t)
    setText('')
  }

  return (
    <div className="shrink-0 border-t bg-background px-6 py-3">
      <div className="flex items-end gap-2 rounded-xl border border-input bg-background p-2 transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15">
        <div className="flex items-center gap-0.5">
          <button
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="添加附件"
            title="添加附件"
          >
            <Paperclip size={15} />
          </button>
          <button
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="提及数据集"
            title="提及数据集"
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
      <div className="mt-1.5 text-center text-[11px] text-muted-foreground">
        Enter 发送 · Shift+Enter 换行 · @ 提及数据集
      </div>
    </div>
  )
}