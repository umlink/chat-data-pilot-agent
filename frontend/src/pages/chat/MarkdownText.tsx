import ReactMarkdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

/**
 * LLM 回复文本渲染（docs/UI设计规范.md 4.x text block）。
 * 用 react-markdown 而非 dangerouslySetInnerHTML：默认不执行原始 HTML，
 * LLM 输出视为不可信数据（XSS 安全）；remark-breaks 保留单换行，
 * 与流式 token 拼接后的多行段落观感一致。
 */

/**
 * 历史压缩时把 table/chart block 摘要成 `[数据表] 列: ...` / `[图表] ...` 喂给 LLM，
 * LLM 有时会在新回答里模仿输出这些内部引用行。它们不是给用户看的内容（真表格已单独
 * 渲染为 table block），渲染前剔除这些行，避免文本里出现重复/冗余摘要。
 */
function stripInternalDataRefs(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*\[数据表\]/.test(line) && !/^\s*\[图表\]/.test(line))
    .join('\n')
    .trim()
}

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
      {children}
    </a>
  ),
  // 块级代码（fenced，pre 内）：pre 组件已提供底色，code 只保留字体
  code: ({ className, children, ...rest }) => {
    if (className) {
      return (
        <code className="font-mono" {...rest}>
          {children}
        </code>
      )
    }
    return (
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground" {...rest}>
        {children}
      </code>
    )
  },
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-lg border border-code-border bg-code-bg px-3.5 py-2.5 font-mono text-xs leading-relaxed text-code-fg">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-muted bg-muted/50 px-2.5 py-1.5 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-b border-muted/50 px-2.5 py-1.5 text-foreground">{children}</td>
  ),
}

export function MarkdownText({ text }: { text: string }) {
  const cleaned = stripInternalDataRefs(text)
  return (
    <div className="break-words text-[13px] leading-6 text-foreground [&>*+*]:mt-2 [&_blockquote]:border-l-2 [&_blockquote]:border-muted [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_h1]:mb-1 [&_h1]:mt-3 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-[14px] [&_h3]:font-semibold [&_hr]:my-3 [&_hr]:border-muted [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {cleaned}
      </ReactMarkdown>
    </div>
  )
}
