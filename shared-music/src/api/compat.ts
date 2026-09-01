/** AbortSignal.timeout 的浏览器兼容实现（老 WebView Chromium 可能缺失）。 */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), ms)
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  return controller.signal
}

/**
 * 保持 window/globalThis 上下文的 fetch 包装。
 * 在浏览器/WebView 里，把全局 fetch 解构后当普通函数调用会抛
 * "TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation"。
 * 所有共享层里 `fetcher = fetch` 的默认值都应换成此包装，保证 this 绑定正确。
 */
export function safeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return (globalThis as { fetch: typeof fetch }).fetch(input, init)
}