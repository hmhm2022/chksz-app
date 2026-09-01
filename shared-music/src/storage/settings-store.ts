import type { Settings } from '../contracts'
import { MusicDB, SETTINGS_SNAPSHOT_KEY } from './db'

/**
 * 应用设置存储（浏览器 IndexedDB 版，Dexie 底层）。
 *
 * 接口语义与桌面版 SettingsStore（JSON 文件版）完全一致：
 * `get()` 用默认值合并存储，`update()` 增量合并、volume 限制在 0-1。
 * 移动端没有真实下载目录，downloadDirectory 先给空串占位（Task 7 裁剪时再定）。
 */
export class SettingsStore {
  private readonly db: MusicDB
  private readonly defaults: Settings
  /** 写队列：串行化读改写，避免并发修改互相覆盖。 */
  private tail: Promise<void> = Promise.resolve()

  constructor(db?: MusicDB) {
    this.db = db ?? new MusicDB()
    this.defaults = {
      defaultPlatform: 'netease',
      neteaseQuality: 'lossless',
      qqQuality: 'flac',
      kugouQuality: 'flac',
      downloadDirectory: '',
      volume: 0.8,
      repeatMode: 'sequence',
      showCoverArt: true,
      neteaseSearchFree: true,
      qqSearchFree: true,
      kugouSearchFree: true,
      dailyQuota: 400,
      apiBaseUrl: ''
    }
  }

  async get(): Promise<Settings> {
    await this.tail
    const stored = await this.db.getSnapshotRow<Partial<Settings>>(SETTINGS_SNAPSHOT_KEY)
    return { ...this.defaults, ...stored }
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const operation = this.tail.then(async () => {
      // 注意：这里直接读存储合并默认值，不能调用 get() —— get() 会 await this.tail，
      // 而从 tail 链内调用会死锁（tail 含本操作自身）。
      const stored = await this.db.getSnapshotRow<Partial<Settings>>(SETTINGS_SNAPSHOT_KEY)
      const current: Settings = { ...this.defaults, ...stored }
      const next: Settings = {
        ...current,
        ...patch,
        volume: Math.min(1, Math.max(0, patch.volume ?? current.volume))
      }
      await this.db.putSnapshotRow(SETTINGS_SNAPSHOT_KEY, next)
      return next
    })
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }
}