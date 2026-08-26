import { Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const CATEGORY_OPTIONS = [
  { value: '', label: '全部分类' },
  { value: 'system', label: '系统' },
  { value: 'application', label: '应用' },
  { value: 'ai', label: 'AI' },
  { value: 'error', label: '错误' },
  { value: 'audit', label: '审计' },
]

const LEVEL_OPTIONS = [
  { value: '', label: '全部级别' },
  { value: 'DEBUG', label: 'DEBUG' },
  { value: 'INFO', label: 'INFO' },
  { value: 'WARNING', label: 'WARNING' },
  { value: 'ERROR', label: 'ERROR' },
  { value: 'CRITICAL', label: 'CRITICAL' },
]

interface Props {
  category: string
  level: string
  keyword: string
  start: string
  end: string
  onCategoryChange: (v: string) => void
  onLevelChange: (v: string) => void
  onKeywordChange: (v: string) => void
  onStartChange: (v: string) => void
  onEndChange: (v: string) => void
  onReset: () => void
}

/** 日志筛选区：分类 / 级别 / 关键词（防抖）/ 时间范围（datetime-local）。 */
export function LogsFilter({
  category,
  level,
  keyword,
  start,
  end,
  onCategoryChange,
  onLevelChange,
  onKeywordChange,
  onStartChange,
  onEndChange,
  onReset,
}: Props) {
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
      <div className="space-y-1.5">
        <Label>分类</Label>
        <Select value={category} onValueChange={(v) => onCategoryChange(String(v ?? ''))}>
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="全部分类" />
          </SelectTrigger>
          <SelectContent>
            {CATEGORY_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label>级别</Label>
        <Select value={level} onValueChange={(v) => onLevelChange(String(v ?? ''))}>
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="全部级别" />
          </SelectTrigger>
          <SelectContent>
            {LEVEL_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="min-w-[200px] flex-1 space-y-1.5">
        <Label>关键词</Label>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(e) => onKeywordChange(e.target.value)}
            placeholder="搜索日志消息…（输入停顿 400ms 自动查询）"
            className="pl-7"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>开始时间</Label>
        <Input type="datetime-local" value={start} onChange={(e) => onStartChange(e.target.value)} />
      </div>

      <div className="space-y-1.5">
        <Label>结束时间</Label>
        <Input type="datetime-local" value={end} onChange={(e) => onEndChange(e.target.value)} />
      </div>

      <Button variant="outline" onClick={onReset}>
        重置
      </Button>
    </div>
  )
}
