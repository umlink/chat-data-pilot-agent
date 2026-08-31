import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ConfigMap } from '@/types/config'
import { ConfigCard, FieldRow, fieldInputCls } from './FormKit'

interface Props {
  config: ConfigMap
  setField: (key: string, field: string, value: unknown) => void
}

function NumInput({
  id,
  name,
  value,
  onChange,
  min = 0,
}: {
  id?: string
  name?: string
  value: unknown
  onChange: (v: number) => void
  min?: number
}) {
  return (
    <Input
      type="number"
      id={id}
      name={name}
      autoComplete="off"
      min={min}
      className={fieldInputCls()}
      value={Number(value ?? 0)}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}

// Base UI Select 的 SelectValue 默认渲染原始 value（如 normal），
// 需通过 items 映射才能在 trigger 中显示选中项 label
const SAFE_MODE_ITEMS: Record<string, string> = {
  normal: 'normal（允许执行，危险操作走确认）',
  readonly: 'readonly（只允许 SELECT）',
}

/** 系统配置 tab：查询 / 任务 / 上传 / 会话 / SQL 安全 / 日志（docs/技术方案设计 3.6） */
export function SystemConfigTab({ config, setField }: Props) {
  const query = config['system.query'] ?? {}
  const task = config['system.task'] ?? {}
  const upload = config['system.upload'] ?? {}
  const session = config['system.session'] ?? {}
  const sql = config['system.sql'] ?? {}
  const log = config['system.log'] ?? {}

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <ConfigCard title="查询引擎" hint="SQL 查询返回结果上限（system.query）">
        <FieldRow label="最大返回行数" htmlFor="cfg-max-query-rows">
          <NumInput
            id="cfg-max-query-rows"
            name="max_query_rows"
            value={query.max_query_rows}
            min={1}
            onChange={(v) => setField('system.query', 'max_query_rows', v)}
          />
        </FieldRow>
      </ConfigCard>

      <ConfigCard title="任务队列" hint="Worker 执行与并发（system.task）">
        <FieldRow label="超时（秒）" htmlFor="cfg-task-timeout">
          <NumInput
            id="cfg-task-timeout"
            name="timeout_seconds"
            value={task.timeout_seconds}
            min={1}
            onChange={(v) => setField('system.task', 'timeout_seconds', v)}
          />
        </FieldRow>
        <FieldRow label="最大并发" htmlFor="cfg-task-concurrency">
          <NumInput
            id="cfg-task-concurrency"
            name="max_concurrency"
            value={task.max_concurrency}
            min={1}
            onChange={(v) => setField('system.task', 'max_concurrency', v)}
          />
        </FieldRow>
      </ConfigCard>

      <ConfigCard title="附件上传" hint="单文件大小上限（system.upload）">
        <FieldRow label="最大大小（MB）" htmlFor="cfg-upload-size">
          <NumInput
            id="cfg-upload-size"
            name="max_size_mb"
            value={upload.max_size_mb}
            min={1}
            onChange={(v) => setField('system.upload', 'max_size_mb', v)}
          />
        </FieldRow>
      </ConfigCard>

      <ConfigCard title="会话与日志保留" hint="自动清理周期（system.session / system.log）">
        <FieldRow label="会话保留（天）" htmlFor="cfg-session-retention">
          <NumInput
            id="cfg-session-retention"
            name="retention_days"
            value={session.retention_days}
            min={1}
            onChange={(v) => setField('system.session', 'retention_days', v)}
          />
        </FieldRow>
        <FieldRow label="日志保留（天）" htmlFor="cfg-log-retention">
          <NumInput
            id="cfg-log-retention"
            name="retention_days"
            value={log.retention_days}
            min={1}
            onChange={(v) => setField('system.log', 'retention_days', v)}
          />
        </FieldRow>
      </ConfigCard>

      <ConfigCard title="SQL 安全模式" hint="M2 起由 SQL Agent 消费（system.sql）。normal 允许读写，readonly 只读校验">
        <FieldRow label="安全模式">
          <Select value={String(sql.safe_mode ?? 'normal')} items={SAFE_MODE_ITEMS} onValueChange={(v) => setField('system.sql', 'safe_mode', v)}>
            <SelectTrigger className="h-7 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="normal">normal（允许执行，危险操作走确认）</SelectItem>
              <SelectItem value="readonly">readonly（只允许 SELECT）</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
      </ConfigCard>
    </div>
  )
}

// oxlint-disable-next-line react/only-export-components -- 共享常量函数（非组件），ConfigPage 复用
export function makeSystemKeys(): string[] {
  return ['system.query', 'system.task', 'system.upload', 'system.session', 'system.sql', 'system.log']
}
