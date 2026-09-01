import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlaylistRef, Song } from '../contracts'
import { MusicDB } from './db'
import { LibraryStore } from './library-store'
import { SettingsStore } from './settings-store'

let seq = 0
/** 每个用例独立数据库，避免互相污染（randomUUID 保证跨用例/跨运行唯一）。 */
function freshStore(): LibraryStore {
  seq += 1
  return new LibraryStore(new MusicDB(`test-music-${seq}-${crypto.randomUUID()}`))
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

function importRef(sourceId: string): PlaylistRef {
  return {
    id: `ref-${sourceId}`,
    sourceId,
    name: `歌单 ${sourceId}`,
    cover: '',
    creator: '网易云音乐',
    songCount: 0,
    songs: [],
    updatedAt: new Date().toISOString(),
    source: 'free'
  }
}

beforeEach(() => {
  // 清空 fake-indexeddb 的全局库，保证库间隔离。
  seq = 0
})

afterEach(() => {
  // noop（每个用例独立 db 名）
})

describe('LibraryStore', () => {
  it('初始快照为空', async () => {
    const store = freshStore()
    expect(await store.getSnapshot()).toEqual({ favorites: [], history: [], playlists: [], neteaseImports: [] })
  })

  it('toggleFavorite 收藏/取消收藏', async () => {
    const store = freshStore()
    const a = song('a')
    await store.toggleFavorite(a)
    let snap = await store.getSnapshot()
    expect(snap.favorites).toHaveLength(1)
    expect(snap.favorites[0].key).toBe('netease:a')
    await store.toggleFavorite(a)
    snap = await store.getSnapshot()
    expect(snap.favorites).toHaveLength(0)
  })

  it('recordPlayed 前插去重并限 200', async () => {
    const store = freshStore()
    for (let i = 1; i <= 210; i++) await store.recordPlayed(song(String(i)))
    let snap = await store.getSnapshot()
    expect(snap.history).toHaveLength(200)
    expect(snap.history[0].key).toBe('netease:210')
    // 重复播放已存在歌曲应前插且去重
    await store.recordPlayed(song('100'))
    snap = await store.getSnapshot()
    expect(snap.history).toHaveLength(200)
    expect(snap.history[0].key).toBe('netease:100')
    expect(snap.history.filter(s => s.key === 'netease:100')).toHaveLength(1)
  })

  it('createPlaylist 校验名称并截断 60 字', async () => {
    const store = freshStore()
    await expect(store.createPlaylist('   ')).rejects.toThrow('请输入歌单名称')
    const snap = await store.createPlaylist('  我的歌单  ')
    expect(snap.playlists[0].name).toBe('我的歌单')
    expect(snap.playlists[0].source).toBe('custom')
    expect(snap.playlists[0].id).toBeTruthy()
  })

  it('addSongs 批量去重、addSong 单条去重、removeSong 移除', async () => {
    const store = freshStore()
    const snap0 = await store.createPlaylist('测试')
    const pid = snap0.playlists[0].id
    const a = song('a')
    const b = song('b')
    await store.addSongs(pid, [a, b])
    let snap = await store.getSnapshot()
    expect(snap.playlists[0].songs).toHaveLength(2)
    // 重复批量添加应去重
    await store.addSongs(pid, [a, song('c')])
    snap = await store.getSnapshot()
    expect(snap.playlists[0].songs.map(s => s.key)).toEqual(['netease:a', 'netease:b', 'netease:c'])
    // addSong 已存在不重复
    await store.addSong(pid, a)
    snap = await store.getSnapshot()
    expect(snap.playlists[0].songs).toHaveLength(3)
    // removeSong
    await store.removeSong(pid, 'netease:b')
    snap = await store.getSnapshot()
    expect(snap.playlists[0].songs.map(s => s.key)).toEqual(['netease:a', 'netease:c'])
  })

  it('操作不存在的歌单抛「歌单不存在」', async () => {
    const store = freshStore()
    await expect(store.addSong('nope', song('a'))).rejects.toThrow('歌单不存在')
    await expect(store.renamePlaylist('nope', '新名字')).rejects.toThrow('歌单不存在')
  })

  it('reorderSong 越界忽略', async () => {
    const store = freshStore()
    const snap0 = await store.createPlaylist('排序')
    const pid = snap0.playlists[0].id
    await store.addSongs(pid, [song('a'), song('b'), song('c')])
    await store.reorderSong(pid, 0, 2)
    let snap = await store.getSnapshot()
    expect(snap.playlists[0].songs.map(s => s.key)).toEqual(['netease:b', 'netease:c', 'netease:a'])
    // 越界忽略，顺序不变
    await store.reorderSong(pid, 5, 0)
    snap = await store.getSnapshot()
    expect(snap.playlists[0].songs.map(s => s.key)).toEqual(['netease:b', 'netease:c', 'netease:a'])
  })

  it('saveNeteaseImport 按 sourceId 去重置顶并限 10', async () => {
    const store = freshStore()
    for (let i = 1; i <= 12; i++) await store.saveNeteaseImport(importRef(String(i)))
    let imports = await store.getNeteaseImports()
    expect(imports).toHaveLength(10)
    // 最新的在最前
    expect(imports[0].sourceId).toBe('12')
    expect(imports[9].sourceId).toBe('3')
    // 再次保存已存在的 sourceId 去重置顶
    await store.saveNeteaseImport(importRef('5'))
    imports = await store.getNeteaseImports()
    expect(imports).toHaveLength(10)
    expect(imports[0].sourceId).toBe('5')
    expect(imports.filter(r => r.sourceId === '5')).toHaveLength(1)
  })

  it('updateNeteaseImport 更新已有快照保持排序；不存在则保存', async () => {
    const store = freshStore()
    await store.saveNeteaseImport(importRef('a'))
    await store.saveNeteaseImport(importRef('b'))
    await store.updateNeteaseImport({ ...importRef('a'), name: '改名' })
    let imports = await store.getNeteaseImports()
    expect(imports).toHaveLength(2)
    expect(imports.map(r => r.sourceId)).toEqual(['b', 'a'])
    expect(imports[1].name).toBe('改名')
    // getNeteaseImport 按 sourceId 取
    const found = await store.getNeteaseImport('a')
    expect(found?.name).toBe('改名')
    expect(await store.getNeteaseImport('missing')).toBeNull()
    // 不存在则保存
    await store.updateNeteaseImport(importRef('c'))
    imports = await store.getNeteaseImports()
    expect(imports.map(r => r.sourceId)).toEqual(['c', 'b', 'a'])
  })
})

describe('SettingsStore', () => {
  it('get 返回默认值合并存储', async () => {
    seq += 1
    const store = new SettingsStore(new MusicDB(`test-settings-${seq}-${crypto.randomUUID()}`))
    const defaults = await store.get()
    expect(defaults.defaultPlatform).toBe('netease')
    expect(defaults.neteaseQuality).toBe('lossless')
    expect(defaults.qqQuality).toBe('flac')
    expect(defaults.kugouQuality).toBe('flac')
    expect(defaults.volume).toBe(0.8)
    expect(defaults.downloadDirectory).toBe('')
    expect(defaults.repeatMode).toBe('sequence')
    expect(defaults.showCoverArt).toBe(true)
    expect(defaults.neteaseSearchFree).toBe(true)
    expect(defaults.dailyQuota).toBe(400)
  })

  it('update 增量合并且 volume clamp 0-1', async () => {
    seq += 1
    const store = new SettingsStore(new MusicDB(`test-settings-${seq}-${crypto.randomUUID()}`))
    const updated = await store.update({ volume: 1.5 })
    expect(updated.volume).toBe(1)
    const next = await store.update({ volume: -0.2, defaultPlatform: 'qq' })
    expect(next.volume).toBe(0)
    expect(next.defaultPlatform).toBe('qq')
    const merged = await store.get()
    expect(merged.volume).toBe(0)
    expect(merged.defaultPlatform).toBe('qq')
    expect(merged.neteaseQuality).toBe('lossless')
    expect(merged.qqQuality).toBe('flac')
  })
})