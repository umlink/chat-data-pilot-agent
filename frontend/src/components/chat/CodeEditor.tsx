import Editor, { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor/editor/editor.api'
// SQL 等 basic 语言语法高亮（0.56 版本单文件注册全部 basic 语言）
import 'monaco-editor/basic-languages/monaco.contribution'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'

// 本地 monaco + worker（不走 CDN，适配内网环境）；vite 通过 ?worker 打包
;(self as unknown as { MonacoEnvironment?: { getWorker: () => Worker } }).MonacoEnvironment = {
  getWorker: () => new editorWorker(),
}
loader.config({ monaco })

interface Props {
  value: string
  readOnly: boolean
  height: number
  onChange?: (value: string) => void
}

/**
 * Monaco Editor 封装（docs/技术方案设计 6.1 / PRD 3.1.3）：
 * - 只读态回显 SQL 语法高亮，编辑态可编辑；
 * - 本模块经 React.lazy 独立分包，仅出现 code block 时加载（技术方案「按需加载 Monaco」）。
 */
export function CodeEditor({ value, readOnly, height, onChange }: Props) {
  return (
    <Editor
      height={height}
      defaultLanguage="sql"
      language="sql"
      value={value}
      onChange={onChange ? (v) => onChange(v ?? '') : undefined}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 12,
        lineNumbers: readOnly ? 'off' : 'on',
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        automaticLayout: true,
        renderLineHighlight: readOnly ? 'none' : 'line',
        overviewRulerBorder: false,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        padding: { top: 8, bottom: 8 },
        contextmenu: !readOnly,
        folding: false,
      }}
    />
  )
}
