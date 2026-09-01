import type { Song } from '../contracts'
import { MusicDB } from './db'

/**
 * 已下载歌曲记录（存入 MusicDB.downloads 表）。
 * body.uri 为 MediaStore 的 content:// URI（下载完成时回填）。
 */
export interface DownloadRecord {
  /** 下载任务 ID（JS 侧生成 uuid，原生回推进度用）。 */
  taskId: string
  song: Song
  /** 下载时的音质档位（netease: lossless/JYMaster…，qq/kugou: size 档位）。 */
  quality: string
  /** 已下载字节数。 */
  size: number
  /** 完成时间（ISO 字符串）。 */
  createdAt: string
  /** 下载完成后的 content:// URI；失败记录无值。 */
  uri?: string
}

/**
 * 已下载列表存储（浏览器 IndexedDB 版，Dexie 底层）。
 *
 * 下载管理页的「历史已完成」数据源：任务进行中只活在内存
 * （DownloadsProvider state），下载成功才落库（DownloadsPage 读取）。
 * 与 LibraryStore 同构：全量读改写 + 写队列串行化。
 */
export class DownloadsStore {
  private readonly db: MusicDB
  /** 写队列：串行化读改写，避免并发修改互相覆盖。 */
  private tail: Promise<void> = Promise.resolve()

  constructor(db?: MusicDB) {
    this.db = db ?? new MusicDB()
  }

  /** 已下载记录（时间倒序，最新在前）。 */
  async getDownloads(): Promise<DownloadRecord[]> {
    await this.tail
    return this.read()
  }

  /** 已下载歌曲 key 集合（下载按钮「已下载过」禁用态用）。 */
  async downloadedKeys(): Promise<Set<string>> {
    const records = await this.getDownloads()
    return new Set(records.map(record => record.song.key))
  }

  /** 保存一条下载记录（按 taskId 去重置顶）。 */
  async save(record: DownloadRecord): Promise<void> {
    const operation = this.tail.then(async () => {
      await this.db.downloads.put({
        taskId: record.taskId,
        createdAt: record.createdAt,
        value: record,
      })
    })
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async read(): Promise<DownloadRecord[]> {
    const rows = await this.db.downloads.orderBy('createdAt').reverse().toArray()
    return rows.map(row => row.value as DownloadRecord)
  }
}