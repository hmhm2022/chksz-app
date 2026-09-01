import type { LibrarySnapshot, LocalPlaylist, PlaylistRef, Song } from '../contracts'
import { LIBRARY_SNAPSHOT_KEY, MusicDB } from './db'

const EMPTY_LIBRARY: LibrarySnapshot = { favorites: [], history: [], playlists: [], neteaseImports: [] }
/** 最多保留最近导入的 10 个网易歌单快照，避免库无限膨胀。 */
const NETEASE_IMPORT_LIMIT = 10
/** 播放历史最多保留 200 条。 */
const HISTORY_LIMIT = 200

/**
 * 本地音乐库存储（浏览器 IndexedDB 版，Dexie 底层）。
 *
 * 接口语义与桌面版 LibraryStore（JSON 文件版）完全一致，
 * 方法都返回整份 LibrarySnapshot；内部是「全量读改写」。
 */
export class LibraryStore {
  private readonly db: MusicDB
  /** 写队列：串行化读改写，避免并发修改互相覆盖。 */
  private tail: Promise<void> = Promise.resolve()

  constructor(db?: MusicDB) {
    this.db = db ?? new MusicDB()
  }

  async getSnapshot(): Promise<LibrarySnapshot> {
    await this.tail
    return structuredClone(await this.read())
  }

  toggleFavorite(song: Song): Promise<LibrarySnapshot> {
    return this.mutate(library => {
      const index = library.favorites.findIndex(item => item.key === song.key)
      if (index >= 0) library.favorites.splice(index, 1)
      else library.favorites.unshift(song)
    })
  }

  recordPlayed(song: Song): Promise<LibrarySnapshot> {
    return this.mutate(library => {
      library.history = [song, ...library.history.filter(item => item.key !== song.key)].slice(0, HISTORY_LIMIT)
    })
  }

  clearHistory(): Promise<LibrarySnapshot> {
    return this.mutate(library => { library.history = [] })
  }

  createPlaylist(name: string): Promise<LibrarySnapshot> {
    return this.mutate(library => {
      const now = new Date().toISOString()
      const playlist: LocalPlaylist = {
        id: crypto.randomUUID(),
        name: this.validName(name),
        songs: [],
        createdAt: now,
        updatedAt: now,
        source: 'custom',
        sourceId: null
      }
      library.playlists.unshift(playlist)
    })
  }

  renamePlaylist(id: string, name: string): Promise<LibrarySnapshot> {
    return this.mutate(library => {
      const playlist = this.playlist(library, id)
      playlist.name = this.validName(name)
      playlist.updatedAt = new Date().toISOString()
    })
  }

  deletePlaylist(id: string): Promise<LibrarySnapshot> {
    return this.mutate(library => { library.playlists = library.playlists.filter(item => item.id !== id) })
  }

  addSong(playlistId: string, song: Song): Promise<LibrarySnapshot> {
    return this.mutate(library => {
      const playlist = this.playlist(library, playlistId)
      if (!playlist.songs.some(item => item.key === song.key)) playlist.songs.push(song)
      playlist.updatedAt = new Date().toISOString()
    })
  }

  /** 批量添加歌曲：按 key 去重追加（目标歌单已存在的跳过）。 */
  addSongs(playlistId: string, songs: Song[]): Promise<LibrarySnapshot> {
    return this.mutate(library => {
      const playlist = this.playlist(library, playlistId)
      const existing = new Set(playlist.songs.map(item => item.key))
      for (const song of songs) {
        if (!existing.has(song.key)) {
          playlist.songs.push(song)
          existing.add(song.key)
        }
      }
      playlist.updatedAt = new Date().toISOString()
    })
  }

  removeSong(playlistId: string, songKey: string): Promise<LibrarySnapshot> {
    return this.mutate(library => {
      const playlist = this.playlist(library, playlistId)
      playlist.songs = playlist.songs.filter(item => item.key !== songKey)
      playlist.updatedAt = new Date().toISOString()
    })
  }

  reorderSong(playlistId: string, from: number, to: number): Promise<LibrarySnapshot> {
    return this.mutate(library => {
      const playlist = this.playlist(library, playlistId)
      if (from < 0 || from >= playlist.songs.length || to < 0 || to >= playlist.songs.length) return
      const [song] = playlist.songs.splice(from, 1)
      if (song) playlist.songs.splice(to, 0, song)
      playlist.updatedAt = new Date().toISOString()
    })
  }

  /** 保存网易歌单快照：按 sourceId 去重置顶，超出上限丢弃最旧的。 */
  saveNeteaseImport(ref: PlaylistRef): Promise<LibrarySnapshot> {
    return this.mutate(library => {
      library.neteaseImports = [
        ref,
        ...library.neteaseImports.filter(item => item.sourceId !== ref.sourceId)
      ].slice(0, NETEASE_IMPORT_LIMIT)
    })
  }

  /** 更新已有快照（后台静默刷新用），保持原有排序；不存在则直接保存。 */
  updateNeteaseImport(ref: PlaylistRef): Promise<LibrarySnapshot> {
    return this.mutate(library => {
      const index = library.neteaseImports.findIndex(item => item.sourceId === ref.sourceId)
      if (index >= 0) library.neteaseImports[index] = ref
      else library.neteaseImports = [ref, ...library.neteaseImports].slice(0, NETEASE_IMPORT_LIMIT)
    })
  }

  /** 最近导入的网易歌单快照列表（时间倒序）。 */
  async getNeteaseImports(): Promise<PlaylistRef[]> {
    const library = await this.getSnapshot()
    return library.neteaseImports
  }

  /** 按 sourceId 读取已保存的网易歌单快照；不存在返回 null。 */
  async getNeteaseImport(sourceId: string): Promise<PlaylistRef | null> {
    const imports = await this.getNeteaseImports()
    return imports.find(item => item.sourceId === sourceId) ?? null
  }

  private async read(): Promise<LibrarySnapshot> {
    const snapshot = await this.db.getSnapshotRow<LibrarySnapshot>(LIBRARY_SNAPSHOT_KEY)
    if (!snapshot) return structuredClone(EMPTY_LIBRARY)
    // 规范化缺失字段（旧数据兜底），使读写路径都安全。
    return {
      favorites: Array.isArray(snapshot.favorites) ? snapshot.favorites : [],
      history: Array.isArray(snapshot.history) ? snapshot.history : [],
      playlists: Array.isArray(snapshot.playlists) ? snapshot.playlists : [],
      neteaseImports: Array.isArray(snapshot.neteaseImports) ? snapshot.neteaseImports : []
    }
  }

  private async write(snapshot: LibrarySnapshot): Promise<void> {
    await this.db.putSnapshotRow(LIBRARY_SNAPSHOT_KEY, snapshot)
  }

  private mutate(change: (library: LibrarySnapshot) => void): Promise<LibrarySnapshot> {
    const operation = this.tail.then(async () => {
      const library = await this.read()
      change(library)
      await this.write(library)
      return structuredClone(library)
    })
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private validName(name: string): string {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('请输入歌单名称')
    return trimmed.slice(0, 60)
  }

  private playlist(library: LibrarySnapshot, id: string): LocalPlaylist {
    const value = library.playlists.find(item => item.id === id)
    if (!value) throw new Error('歌单不存在')
    return value
  }
}