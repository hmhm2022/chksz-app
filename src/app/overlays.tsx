import { createContext, use, useRef } from 'react'

/**
 * 全局浮层注册表（返回键关闭顶层浮层）。
 *
 * 浮层状态（音质/音量 sheet、导入弹层、播放器歌词/队列）分散在各组件使用
 * 组件本地 useState 管理，不提升到 AppState reducer（reducer 只负责页面导航，
 * 浮层仍是瞬态 UI）。返回键要「先关浮动层」需要一份全局可读的顶层浮层句柄，
 * 于是由各浮层组件在开启时把 close 回调注册进来，App 的 handleHardwareBack 先
 * 关最上层再逐级返回。
 *
 * 用 ref（registry 实例存 useRef）持有，不触发重渲染——浮层自身的渲染由组件
 * 本地 state 驱动，这里只管「谁是最上层、怎么关闭它」。
 */

export interface OverlayHandle {
  /** 唯一标识（调试/去重用）。 */
  id: string
  /** 关闭该浮层的回调（组件提供：如 setQualityOpen(false)）。 */
  close: () => void
}

export interface OverlayRegistry {
  /** 注册浮层，返回解除注册函数（组件卸载/浮层关闭时调用）。 */
  register: (handle: OverlayHandle) => () => void
  /** 关闭当前顶层浮层；有浮层被关闭返回 true，否则 false。 */
  closeTop: () => boolean
  /** 当前浮层数（调试用）。 */
  size: number
}

/** 创建浮层注册表（App 根唯一实例）。 */
export function createOverlayRegistry(): OverlayRegistry {
  const stack: OverlayHandle[] = []
  return {
    register(handle: OverlayHandle): () => void {
      // 同 id 已注册（如某浮层重开）先移除旧位，再 push 到顶——保证 closeTop 关顶层。
      const existing = stack.findIndex((item) => item.id === handle.id)
      if (existing >= 0) stack.splice(existing, 1)
      stack.push(handle)
      return () => {
        const index = stack.findIndex((item) => item.id === handle.id)
        if (index >= 0) stack.splice(index, 1)
      }
    },
    closeTop(): boolean {
      const top = stack[stack.length - 1]
      if (!top) return false
      stack.pop()
      top.close()
      return true
    },
    get size() {
      return stack.length
    },
  }
}

/** 供组件使用的 hook：返回创建好的 registry 实例（App 根统一建，经 context 下发）。 */
const OverlayContext = createContext<OverlayRegistry | null>(null)

export function OverlayProvider({ children }: { children: React.ReactNode }) {
  const registry = useRef<OverlayRegistry | null>(null)
  if (registry.current === null) registry.current = createOverlayRegistry()
  return <OverlayContext value={registry.current}>{children}</OverlayContext>
}

export function useOverlayRegistry(): OverlayRegistry {
  const registry = use(OverlayContext)
  if (!registry) throw new Error('OverlayProvider is missing')
  return registry
}