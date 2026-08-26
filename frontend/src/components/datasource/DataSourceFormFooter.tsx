import { Button } from '@/components/ui/button'
import type { TestResult } from './constants'

interface Props {
  error: string
  testResult: TestResult | null
  testing: boolean
  saving: boolean
  /** 文件型数据源 / 名称为空时禁用测试与保存 */
  disabled: boolean
  onTest: () => void
  onSave: () => void
  onCancel: () => void
}

/** 数据源表单底部：测试结果展示 + 测试连接 / 取消 / 保存。 */
export function DataSourceFormFooter({ error, testResult, testing, saving, disabled, onTest, onSave, onCancel }: Props) {
  return (
    <>
      {(error || testResult) && (
        <div className="space-y-1">
          {error && <p className="text-xs text-error">{error}</p>}
          {testResult && !testResult.ok && <p className="text-xs text-error">{testResult.error}</p>}
          {testResult?.ok && (
            <p className="text-xs text-success">
              连接成功{testResult.server_version ? `，服务端版本 ${testResult.server_version}` : ''}
            </p>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 border-t pt-4">
        <Button variant="outline" onClick={onTest} disabled={testing || disabled}>
          {testing ? '测试中…' : '测试连接'}
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            取消
          </Button>
          <Button onClick={onSave} disabled={saving || disabled}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </>
  )
}
