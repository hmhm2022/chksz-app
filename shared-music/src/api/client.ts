import { AppError, type AppErrorShape } from '../contracts'
import { safeFetch } from './compat'
import { RequestQueue } from './request-queue'
import { createTimeoutControl, waitForSignal } from './timeout'

interface ClientOptions {
  getKey: () => Promise<string>
  queue: RequestQueue
  fetcher?: typeof fetch
  baseUrl?: string
  timeoutMs?: number
  /** 成功响应解析到免费额度头时回调（可用来落库，见 bridge/index.ts）。 */
  onQuota?: (freeQuota: number) => void
}

function errorFromResponse(status: number, payload: unknown): AppError {
  const message = typeof payload === 'object' && payload !== null && 'msg' in payload && typeof payload.msg === 'string'
    ? payload.msg
    : status === 401 ? '密钥无效，请重新填写' : '接口请求失败'
  const shape: AppErrorShape = {
    code: status === 401 ? 'UNAUTHORIZED' : status === 400 ? 'BAD_REQUEST' : 'NETWORK',
    message
  }
  return new AppError(shape)
}

export class ChkszClient {
  private readonly getKey: () => Promise<string>
  private readonly queue: RequestQueue
  private readonly fetcher: (url: string, init?: RequestInit) => Promise<Response>
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly onQuota: ((freeQuota: number) => void) | undefined
  private freeQuotaRemaining: number | null = null

  constructor(options: ClientOptions) {
    this.getKey = options.getKey
    this.queue = options.queue
    // fetch 必须保持 window/globalThis 上下文调用，否则浏览器抛 TypeError: Illegal invocation。
    this.fetcher = (url, init) => (options.fetcher ?? safeFetch)(url, init)
    this.baseUrl = options.baseUrl ?? 'https://api.chksz.com'
    this.timeoutMs = options.timeoutMs ?? 15000
    this.onQuota = options.onQuota
  }

  /** 最近一次响应头里的免费额度剩余次数；未请求过返回 null。 */
  getFreeQuota(): number | null {
    return this.freeQuotaRemaining
  }

  get<T>(path: string, params: Record<string, string | number>, signal?: AbortSignal): Promise<T> {
    return this.queue.schedule(async () => {
      const key = await this.getKey()
      const search = new URLSearchParams()
      for (const [name, value] of Object.entries(params)) search.set(name, String(value))
      search.set('apikey', key)
      let lastError: Error | null = null
      // 对上游偶发失败重试：实测 Chksz 酷狗 /api/kugou_music 会 200/404 交替（约 25% 成功率），
      // 3 次尝试可把一次请求的成功率提到约 80%。
      for (let attempt = 0; attempt < 3; attempt++) {
        // 重试间隙短暂等待，给上游恢复窗口（最后一步不需要等）。
        if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 400))
        const timeout = createTimeoutControl(signal)
        timeout.start(this.timeoutMs, new Error('请求超时，请稍后重试'))
        let phase: 'response' | 'json' = 'response'
        // 非最后一步（attempt < 2）失败时保留错误继续重试，最后一步才抛出。
        const retryable = attempt < 2
        try {
          const response = await waitForSignal(
            this.fetcher(`${this.baseUrl}${path}?${search.toString()}`, { signal: timeout.signal }),
            timeout.signal
          )
          // 解析免费额度剩余次数（每次成功响应都带该头，实时刷新）。
          const quotaHeader = response.headers?.get('x-quota-free-remaining')
          if (quotaHeader != null) {
            const parsed = Number(quotaHeader)
            if (Number.isFinite(parsed)) {
              this.freeQuotaRemaining = parsed
              // 顺手回调给上层（bridge 落库），消费的是本笔请求已产生的响应，不额外请求。
              this.onQuota?.(parsed)
            }
          }
          phase = 'json'
          const payload = await waitForSignal(response.json(), timeout.signal)
          if (!response.ok) {
            const appError = errorFromResponse(response.status, payload)
            if (retryable) { lastError = appError; continue }
            throw appError
          }
          return payload as T
        } catch (error) {
          if (error instanceof AppError) throw error
          if (timeout.timedOut) {
            lastError = new AppError({ code: 'NETWORK', message: '请求超时，请稍后重试' })
            if (retryable) continue
            throw lastError
          }
          if (signal?.aborted) throw new AppError({ code: 'NETWORK', message: '请求已取消' })
          if (phase === 'json') {
            lastError = new AppError({ code: 'NETWORK', message: '接口返回格式异常' })
            if (retryable) continue
            throw lastError
          }
          lastError = new AppError({ code: 'NETWORK', message: '网络请求失败，请检查网络后重试' })
          if (retryable) continue
          throw lastError
        } finally {
          timeout.dispose()
        }
      }
      throw lastError ?? new AppError({ code: 'NETWORK', message: '网络请求失败，请检查网络后重试' })
    }, signal)
  }
}
