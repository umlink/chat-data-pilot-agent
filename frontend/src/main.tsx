import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { initTheme } from './lib/theme'
import { App } from './App.tsx'

// 首帧前应用主题（localStorage / 系统偏好），避免暗色用户看到白屏闪烁
initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
