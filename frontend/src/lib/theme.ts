/**
 * 明暗主题（PRD 5.6）：localStorage 持久化 + 系统偏好兜底。
 * 切换只动 <html> 的 .dark 类，配合 index.css 的 @custom-variant dark 语义变量。
 */
const THEME_KEY = 'datapilot_theme'

export type Theme = 'light' | 'dark'

/** 应用启动时调用：按保存值或系统偏好初始化 */
export function initTheme(): void {
  const saved = localStorage.getItem(THEME_KEY)
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const theme: Theme = saved === 'dark' || saved === 'light' ? saved : prefersDark ? 'dark' : 'light'
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

export function getTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

export function setTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  localStorage.setItem(THEME_KEY, theme)
}
