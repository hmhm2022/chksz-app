import Dexie from 'dexie'

/** 本地音乐库快照（收藏/历史/歌单/网易导入）在 IndexedDB 里的主键。 */
export const LIBRARY_SNAPSHOT_KEY = 'library'
/** 设置快照在 IndexedDB 里的主键。 */
export const SETTINGS_SNAPSHOT_KEY = 'settings'
/** 免费额度快照（值 + 捕获当天日期）在 IndexedDB 里的主键。 */
export const QUOTA_SNAPSHOT_KEY = 'quota'

/**
 * chksz-music 的 IndexedDB 数据库（Dexie 薄封装）。
 *
 * 设计：表 `snapshot` 存整份快照，按 `id` 区分「音乐库」和「设置」；
 * 存储层（LibraryStore / SettingsStore）内部一律「全量读改写」，
 * 与桌面版「整份 JSON 文件 mutate」的语义完全一致，接口零改动。
 * 数据量是几十上百首歌的量级，全量读写足够，不做分表增量。
 *
 * 表 `downloads`（v2，下载管理页）存已完成下载的记录：taskId 主键 +
 * createdAt 倒序索引（列表按时间新→旧）。value 泛型字段由 DownloadsStore
 * 约束为具体记录形状，db 层保持数据无关。
 */
export class MusicDB extends Dexie {
  snapshot!: Dexie.Table<{ id: string; value: unknown }, string>
  /** 已下载歌曲记录：taskId 主键，createdAt 索引（列表按时间倒序）。 */
  downloads!: Dexie.Table<{ taskId: string; createdAt: string; value: unknown }, string>

  /** @param name 数据库名；单测可用唯一名隔离。默认 `chksz-music`。 */
  constructor(name = 'chksz-music') {
    super(name)
    this.version(1).stores({ snapshot: 'id' })
    this.version(2).stores({ snapshot: 'id', downloads: 'taskId, createdAt' })
  }

  /** 读一份快照；不存在返回 null。value 由泛型 T 约束（与 id 绑定的存储类型）。 */
  async getSnapshotRow<T>(id: string): Promise<T | null> {
    const row = await this.snapshot.get(id)
    return row ? (row.value as T) : null
  }

  /** 覆盖写一份快照（全量读改写）。value 由泛型 T 约束（与 id 绑定的存储类型）。 */
  async putSnapshotRow<T>(id: string, value: T): Promise<void> {
    await this.snapshot.put({ id, value } satisfies { id: string; value: T })
  }
}