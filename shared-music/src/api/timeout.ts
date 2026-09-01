export interface TimeoutControl {
  readonly signal: AbortSignal
  readonly timedOut: boolean
  start(timeoutMs: number, reason: Error): void
  clear(): void
  dispose(): void
}

export function createTimeoutControl(parentSignal?: AbortSignal): TimeoutControl {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false

  // 内部超时和调用方取消共用一个信号，结束后会移除监听和计时器。
  const forwardAbort = () => controller.abort(parentSignal?.reason)
  if (parentSignal?.aborted) forwardAbort()
  else parentSignal?.addEventListener('abort', forwardAbort, { once: true })

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  return {
    signal: controller.signal,
    get timedOut() { return timedOut },
    start(timeoutMs, reason) {
      clear()
      timer = setTimeout(() => {
        timedOut = true
        controller.abort(reason)
      }, timeoutMs)
    },
    clear,
    dispose() {
      clear()
      parentSignal?.removeEventListener('abort', forwardAbort)
    }
  }
}

export function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(signal.reason)
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) }
    )
  })
}
