import { describe, expect, it } from 'vitest'
import type { Song } from '@shared/contracts'
import { persistDownloadHistory, taskReducer, type DownloadTask } from './store'

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

function task(id: string, patch: Partial<DownloadTask> = {}): DownloadTask {
  return {
    taskId: id,
    song: song(id),
    quality: 'lossless',
    status: 'downloading',
    progress: 0,
    downloaded: 0,
    total: 0,
    createdAt: 1,
    ...patch,
  }
}

describe('taskReducer', () => {
  it('upsert 新任务插入最前', () => {
    const next = taskReducer([], { type: 'upsert', task: task('a') })
    expect(next).toHaveLength(1)
    expect(next[0]?.taskId).toBe('a')
  })

  it('upsert 同名任务原位更新', () => {
    let tasks = taskReducer([], { type: 'upsert', task: task('a') })
    tasks = taskReducer(tasks, { type: 'upsert', task: task('a', { progress: 50, status: 'downloading' }) })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.progress).toBe(50)
  })

  it('done 进度置 100', () => {
    let tasks = taskReducer([], { type: 'upsert', task: task('a') })
    tasks = taskReducer(tasks, { type: 'upsert', task: task('a', { status: 'done', progress: 100, path: 'content://x' }) })
    expect(tasks[0]?.status).toBe('done')
    expect(tasks[0]?.path).toBe('content://x')
  })

  it('setHistory 保留现有进行中任务', () => {
    const tasks = taskReducer([task('a')], { type: 'setHistory', history: [], keys: new Set() })
    expect(tasks).toHaveLength(1)
  })

  it('remove 移除指定任务（重试时清掉旧 error 任务）', () => {
    const tasks = taskReducer([task('a'), task('b')], { type: 'remove', taskId: 'a' })
    expect(tasks.map(t => t.taskId)).toEqual(['b'])
  })
})

describe('persistDownloadHistory', () => {
  it('成功保存下载记录并按 taskId 去重', async () => {
    const current = task('history', { downloaded: 2048, createdAt: 1000 })
    const persisted = new Set<string>()
    const pending = new Map<string, Promise<import('@shared/storage/downloads-store').DownloadRecord | null>>()
    const saved: unknown[] = []
    const saveHistory = async (record: unknown) => { saved.push(record) }

    const first = await persistDownloadHistory(current, 'content://history', current.downloaded, persisted, pending, saveHistory)
    const duplicate = await persistDownloadHistory(current, 'content://history', current.downloaded, persisted, pending, saveHistory)

    expect(first?.taskId).toBe('history')
    expect(first?.uri).toBe('content://history')
    expect(saved).toHaveLength(1)
    expect(duplicate).toBeNull()
  })

  it('保存失败时释放 taskId，允许后续完成回调再次保存', async () => {
    const current = task('retry-history')
    const persisted = new Set<string>()
    const pending = new Map<string, Promise<import('@shared/storage/downloads-store').DownloadRecord | null>>()
    let attempts = 0
    const saveHistory = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('写入失败')
    }

    const failed = await persistDownloadHistory(current, undefined, 0, persisted, pending, saveHistory)
    const retried = await persistDownloadHistory(current, undefined, 0, persisted, pending, saveHistory)

    expect(failed).toBeNull()
    expect(retried?.taskId).toBe('retry-history')
    expect(attempts).toBe(2)
  })

  it('并发保存第一次失败时，等待中的调用会再次尝试', async () => {
    const current = task('concurrent-history')
    const persisted = new Set<string>()
    const pending = new Map<string, Promise<import('@shared/storage/downloads-store').DownloadRecord | null>>()
    let attempts = 0
    const saveHistory = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('临时写入失败')
    }

    const first = persistDownloadHistory(current, 'content://concurrent', 0, persisted, pending, saveHistory)
    const second = persistDownloadHistory(current, 'content://concurrent', 0, persisted, pending, saveHistory)
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult).toBeNull()
    expect(secondResult?.taskId).toBe('concurrent-history')
    expect(attempts).toBe(2)
    expect(persisted.has('concurrent-history')).toBe(true)
  })
})
