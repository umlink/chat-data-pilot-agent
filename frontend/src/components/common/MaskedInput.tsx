import { Input } from '@/components/ui/input'
import { MASKED } from '@/types/config'

interface Props {
  value: string
  onChange: (value: string) => void
  /** 非掩码时的占位文案 */
  placeholder?: string
  disabled?: boolean
}

/**
 * 密码 / 密钥输入框。
 * 当前值是掩码（******，后端加密字段的出参形状）时用掩码作占位，
 * 提示用户「已配置，留空保存不覆盖旧值」，避免误以为需要重新输入。
 */
export function MaskedInput({ value, onChange, placeholder, disabled }: Props) {
  return (
    <Input
      type="password"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={value === MASKED ? MASKED : placeholder}
      autoComplete="new-password"
      disabled={disabled}
    />
  )
}
