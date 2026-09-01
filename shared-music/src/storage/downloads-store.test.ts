import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Song } from '../contracts'
import { MusicDB } from './db'
import { DownloadsStore, type DownloadRecord } from './downloads-store'

let seq = 0
/** 每个用例独立数据库，避免互相污染（randomUUID 保证跨用例/跨运行唯一）。 */
function freshStore(): DownloadsStore {
  seq += 1
  return new DownloadsStore(new MusicDB(`test-downloads-${seq}-${crypto.randomUUID()}`))
}

function song(id: string): Song {
  return {
    key: `netease:${id}`,
    platform: 'netease',
    id,
    name: `歌曲 ${id}`,
    artists: ['歌手'],
    album: '专辑',
    cover: '',
    duration: 180,
    qualities: ['standard']
  }
}

function record(taskId: string, id: string, at: string, uri?: string): DownloadRecord {
  return { taskId, song: song(id), quality: 'lossless', size: 1024, createdAt: at, uri }
}

beforeEach(() => {
  seq = 0
})

afterEach(() => {
  // noop（每个用例独立 db 名）
})

describe('DownloadsStore', () => {
  it('初始没有下载记录', async () => {
    const store = freshStore()
    expect(await store.getDownloads()).toEqual([])
    expect(await store.downloadedKeys()).toEqual(new Set())
  })

  it('save 后按时间倒序读取', async () => {
    const store = freshStore()
    await store.save(record('t1', 'a', '2026-08-16T01:00:00.000Z'))
    await store.save(record('t2', 'b', '2026-08-16T02:00:00.000Z'))
    const all = await store.getDownloads()
    expect(all.map(item => item.taskId)).toEqual(['t2', 't1'])
    expect(await store.downloadedKeys()).toEqual(new Set(['netease:a', 'netease:b']))
  })

  it('同 taskId 重复 save 去重置顶', async () => {
    const store = freshStore()
    await store.save(record('t1', 'a', '2026-08-16T01:00:00.000Z'))
    await store.save(record('t1', 'b', '2026-08-16T03:00:00.000Z'))
    const all = await store.getDownloads()
    expect(all).toHaveLength(1)
    expect(all[0]?.song.key).toBe('netease:b')
  })

  it('并发 save 不互相覆盖（写队列串行化）', async () => {
    const store = freshStore()
    await Promise.all([
      store.save(record('t1', 'a', '2026-08-16T01:00:00.000Z')),
      store.save(record('t2', 'b', '2026-08-16T02:00:00.000Z')),
    ])
    const all = await store.getDownloads()
    expect(all.map(item => item.taskId).sort()).toEqual(['t1', 't2'])
  })
})