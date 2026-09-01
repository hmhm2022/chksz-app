import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { setupChkszBridge } from './bridge'
import './styles/global.css'

const root = document.getElementById('root')
if (!root) {
  throw new Error('root element not found')
}

// 渲染前先组装 window.chksz，保证 UI 组件首次读取时就绪。
setupChkszBridge()

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
