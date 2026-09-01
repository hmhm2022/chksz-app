import { AppError } from '../contracts'

interface QueueOptions {
  minimumGapMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export class RequestQueue {
  private tail: Promise<void> = Promise.resolve()
  private lastStartedAt = Number.NEGATIVE_INFINITY
  private readonly minimumGapMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: QueueOptions = {}) {
    this.minimumGapMs = options.minimumGapMs ?? 3200
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? defaultSleep
  }

  schedule<T>(task: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    const run = this.tail.then(async () => {
      this.throwIfAborted(signal)
      const waitMs = Math.max(0, this.lastStartedAt + this.minimumGapMs - this.now())
      if (waitMs > 0) await this.sleep(waitMs)
      this.throwIfAborted(signal)
      this.lastStartedAt = this.now()
      return task()
    })
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new AppError({ code: 'NETWORK', message: '请求已取消' })
  }
}
