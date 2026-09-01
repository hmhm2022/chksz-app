import { MusicDB, QUOTA_SNAPSHOT_KEY } from './db'

/** 持久化的免费额度记录：值 + 捕获当天日期（本地日期 YYYY-MM-DD）。 */
export interface QuotaRecord {
  freeQuota: number
  date: string
}

/**
 * 免费额度存储（浏览器 IndexedDB 版，Dexie 底层）。
 *
 * 额度每日重置，故记录必须带捕获日期。读取方（AppState/ProfilePage）负责日期比对：
 * 同日展示真实捕获值，跨日则回落用户设置的每日额度（settings.dailyQuota）。
 * 与 SettingsStore 同构：全量读改写 + 写队列串行化，避免并发覆盖。
 */
export class QuotaStore {
  private readonly db: MusicDB
  /** 写队列：串行化读改写，避免并发修改互相覆盖。 */
  private tail: Promise<void> = Promise.resolve()

  constructor(db?: MusicDB) {
    this.db = db ?? new MusicDB()
  }

  /** 读额度记录；从未存过返回 null。 */
  async get(): Promise<QuotaRecord | null> {
    await this.tail
    return this.db.getSnapshotRow<QuotaRecord>(QUOTA_SNAPSHOT_KEY)
  }

  /** 覆盖写一份额度记录（值 + 捕获当天日期）。 */
  async set(record: QuotaRecord): Promise<void> {
    const operation = this.tail.then(async () => {
      await this.db.putSnapshotRow(QUOTA_SNAPSHOT_KEY, record)
    })
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }
}
