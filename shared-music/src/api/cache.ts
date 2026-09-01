interface CacheValue<T> {
  value: T
  expiresAt: number
}

export class MemoryCache<T> {
  private readonly values = new Map<string, CacheValue<T>>()

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.values.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= now) {
      this.values.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: T, ttlMs: number, now = Date.now()): void {
    this.values.set(key, { value, expiresAt: now + ttlMs })
  }

  clear(): void {
    this.values.clear()
  }
}
