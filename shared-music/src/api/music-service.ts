import { MemoryCache } from './cache'
import { safeFetch } from './compat'
import { AppError, type PlaybackSource, type Playlist, type PlaylistRef, type Song, type MusicPlatform, type NeteasePlaylistSummary } from '../contracts'
import { mapKugouDetail, mapKugouSearch } from './adapters/kugou'
import { searchKugouFree } from './adapters/kugou-search'
import { fetchNeteaseLyricFree, mapNeteasePlayback, mapNeteasePlaylist, mapNeteaseSearch, parseNeteasePlaylistId } from './adapters/netease'
import { hotNeteasePlaylistsFree, neteaseToplistsFree, personalizedPlaylistsFree, recommendNeteasePlaylistsFree, searchNeteasePlaylistsFree, fetchNeteasePlaylistFree, type ToplistSummary } from './adapters/netease-playlist-search'
import { searchNeteaseFree } from './adapters/netease-search'
import { mapQqDetail, mapQqSearch } from './adapters/qq'
import { searchQqFree } from './adapters/qq-search'

interface ClientLike {
  get(path: string, params: Record<string, string | number>, signal?: AbortSignal): Promise<any>
}

/** 网易云歌单快照持久化依赖的最小接口；主进程传 LibraryStore，测试可不传（跳过持久化）。 */
interface NeteaseImportStore {
  saveNeteaseImport(ref: PlaylistRef): Promise<unknown>
  updateNeteaseImport(ref: PlaylistRef): Promise<unknown>
  getNeteaseImport(sourceId: string): Promise<PlaylistRef | null>
  getNeteaseImports(): Promise<PlaylistRef[]>
}

export class MusicService {
  private readonly playlistCache = new MemoryCache<Playlist>()
  private readonly playbackCache = new MemoryCache<PlaybackSource>()
  private readonly fetcher: typeof fetch
  private readonly importStore: NeteaseImportStore | null

  constructor(private readonly client: ClientLike, fetcher: typeof fetch = safeFetch, importStore: NeteaseImportStore | null = null) {
    this.fetcher = fetcher
    this.importStore = importStore
  }

  async search(
    platform: MusicPlatform,
    keyword: string,
    limit = 20,
    signal?: AbortSignal,
    freeSearch: { netease?: boolean; qq?: boolean; kugou?: boolean } = {}
  ): Promise<Song[]> {
    // 用户每次点“搜索”都是一次真实查询（不读缓存）。
    // 各平台免费搜索接口（带封面+时长、不耗 ChKSz 额度）由设置开关控制；
    // 免费源失效时抛可识别错误引导到设置关闭（与网易云同语义），不自动回退 ChKSz 烧额度。
    if (platform === 'qq' && freeSearch.qq !== false) {
      try {
        const free = await searchQqFree(keyword, this.fetcher)
        if (free !== null) return free
      } catch {
        // searchQqFree 内部已吞掉错误返回 null；走到这里视为免费源不可用，抛可识别错误引导。
      }
      throw new AppError({ code: 'NETWORK', message: '免费 QQ 搜索源不可用，请到设置关闭该开关或稍后重试' })
    }
    if (platform === 'kugou' && freeSearch.kugou !== false) {
      try {
        const free = await searchKugouFree(keyword, this.fetcher)
        if (free !== null) return free
      } catch {
        // 同上：searchKugouFree 内部吞错返回 null，这里抛可识别错误。
      }
      throw new AppError({ code: 'NETWORK', message: '免费酷狗搜索源不可用，请到设置关闭该开关或稍后重试' })
    }
    if (platform === 'netease' && freeSearch.netease !== false) {
      // 网易云：免费老接口开启时优先走；老接口失效时抛可识别错误，由上层提示切换 ChKSz。
      return searchNeteaseFree(keyword, this.fetcher)
    }
    const payload = platform === 'netease'
      ? await this.client.get('/api/163_search', { keyword, limit }, signal)
      : platform === 'qq'
        ? await this.client.get('/api/qq_music', { msg: keyword, num: limit, type: 'json' }, signal)
        : await this.client.get('/api/kugou_music', { msg: keyword }, signal)
    return platform === 'netease'
      ? mapNeteaseSearch(payload)
      : platform === 'qq' ? mapQqSearch(payload) : mapKugouSearch(payload)
  }

  async getPlayback(song: Song, quality = song.platform === 'netease' ? 'lossless' : '', forceRefresh = false): Promise<PlaybackSource> {
    const cacheKey = `playback:${song.key}:${quality}`
    if (!forceRefresh) {
      const cached = this.playbackCache.get(cacheKey)
      if (cached) return cached
    }
    let source: PlaybackSource
    if (song.platform === 'netease') {
      // 网易云：播放直链必须走 ChKSz（1 额度）；歌词改走免费官方接口（不耗额度）。
      // 免费歌词源失败 → 歌词留空 + lyricError 提示（不中断播放、不额外花额度）。
      const music = await this.client.get('/api/163_music', { id: song.id, level: quality })
      source = mapNeteasePlayback(music, song, quality)
      try {
        const { lyric, translatedLyric } = await fetchNeteaseLyricFree(song.id, this.fetcher)
        source = { ...source, lyric, translatedLyric }
      } catch {
        source = { ...source, lyric: '', translatedLyric: '', lyricError: '免费歌词源不可用' }
      }
    } else if (song.platform === 'qq') {
      // QQ：quality 作为 size 档位参数（128k/320k/flac/hires/master）。
      source = mapQqDetail(await this.client.get('/api/qq_music', { mid: song.id, type: 'json', size: quality || 'master' }), song)
    } else {
      // 酷狗：quality 作为 size 档位参数。
      source = mapKugouDetail(await this.client.get('/api/kugou_music', { id: song.id, size: quality || 'master' }), song).source
    }
    if (!source.url) throw new Error('该歌曲暂时没有可播放地址')
    this.playbackCache.set(cacheKey, source, 5 * 60 * 1000)
    return source
  }

  /**
   * 网易云独立免费歌词接口（不耗 ChKSz 额度）。原生自动切歌后不再经过 getPlayback，
   * 但网易云歌词本就走这个独立接口，所以由 JS 在收到 onTrackAutoAdvanced 时按需调用即可，
   * 与旧流程（getPlayback 内部调用）等价，不产生额外额度消耗。
   */
  async getNeteaseLyric(songId: string): Promise<{ lyric: string; translatedLyric: string }> {
    try {
      return await fetchNeteaseLyricFree(songId, this.fetcher)
    } catch {
      return { lyric: '', translatedLyric: '' }
    }
  }

  /** 从 ChKSz 拉取网易歌单并保存快照。返回歌单 + 是否已落库。 */
  async importNeteasePlaylist(input: string): Promise<Playlist & { saved: boolean }> {
    const id = parseNeteasePlaylistId(input)
    const cacheKey = `playlist:netease:${id}`
    const cached = this.playlistCache.get(cacheKey)
    const playlist = cached ?? mapNeteasePlaylist(await this.client.get('/api/163_playlist', { id }))
    this.playlistCache.set(cacheKey, playlist, 10 * 60 * 1000)
    const saved = await this.persistSnapshot(playlist, id)
    return { ...playlist, saved }
  }

  /** 把歌单写成 PlaylistRef 快照并落库。返回是否真正写入了磁盘。 */
  private async persistSnapshot(playlist: Playlist, id: string): Promise<boolean> {
    if (!this.importStore) return false
    const ref: PlaylistRef = {
      id: playlist.id || id,
      sourceId: id,
      name: playlist.name,
      cover: playlist.cover,
      creator: playlist.creator,
      songCount: playlist.songs.length,
      songs: playlist.songs,
      updatedAt: new Date().toISOString(),
      source: 'chksz'
    }
    await this.importStore.saveNeteaseImport(ref)
    return true
  }

  /** 最近导入的网易歌单快照列表（时间倒序）。 */
  async savedNeteasePlaylists(): Promise<PlaylistRef[]> {
    return this.importStore ? this.importStore.getNeteaseImports() : []
  }

  /** 按歌单 ID 读取快照：本地有则秒回；forceRefresh=true 或本地无缓存则拉线上并保存。 */
  async neteasePlaylistById(id: string, forceRefresh = false): Promise<PlaylistRef> {
    const existing = this.importStore ? await this.importStore.getNeteaseImport(id) : null
    if (this.importStore && existing && !forceRefresh) return existing
    const { playlist, source } = await this.loadNeteasePlaylist(id)
    const ref: PlaylistRef = {
      id: playlist.id || id, sourceId: id, name: playlist.name, cover: playlist.cover,
      creator: playlist.creator, songCount: playlist.songs.length, songs: playlist.songs, updatedAt: new Date().toISOString(), source
    }
    if (this.importStore) {
      if (existing) await this.importStore.updateNeteaseImport(ref)
      else await this.importStore.saveNeteaseImport(ref)
    }
    return ref
  }

  /** 拉取网易歌单：优先走免费接口（v3+S/D 补时长），失败回退 ChKSz 收费接口。 */
  private async loadNeteasePlaylist(id: string): Promise<{ playlist: Playlist; source: PlaylistRef['source'] }> {
    try {
      return { playlist: await fetchNeteasePlaylistFree(id, this.fetcher), source: 'free' }
    } catch {
      // 免费源失效时回退 ChKSz（无时长但能保证拿到）。
      return { playlist: mapNeteasePlaylist(await this.client.get('/api/163_playlist', { id })), source: 'chksz' }
    }
  }

  /** 精品歌单（精选推荐）：免费老接口，不耗 ChKSz 额度。 */
  async recommendNeteasePlaylists(cat = '全部', limit = 20, before = 0): Promise<{ playlists: NeteasePlaylistSummary[]; total: number }> {
    return recommendNeteasePlaylistsFree(cat, limit, before, this.fetcher)
  }

  /** 全量公开歌单·按热度（分类浏览主体）：免费老接口，必须带具体细分类。 */
  async hotNeteasePlaylists(cat: string, limit = 12, offset = 0): Promise<{ playlists: NeteasePlaylistSummary[]; total: number }> {
    return hotNeteasePlaylistsFree(cat, limit, offset, this.fetcher)
  }

  /** 个性化推荐歌单（"全部"视图顶部）：免费 feed，每次内容不同。 */
  async personalizedPlaylists(limit = 6): Promise<NeteasePlaylistSummary[]> {
    return personalizedPlaylistsFree(limit, this.fetcher)
  }

  /** 官方榜单列表（"全部"视图中部入口）：榜 ID 可直接当歌单打开。 */
  async toplists(): Promise<ToplistSummary[]> {
    return neteaseToplistsFree(this.fetcher)
  }

  /** 搜索公开歌单（搜索发现）：免费老接口，不耗 ChKSz 额度。offset 用于翻页加载。 */
  async searchNeteasePlaylists(keyword: string, limit = 20, offset = 0): Promise<{ playlists: NeteasePlaylistSummary[]; total: number }> {
    return searchNeteasePlaylistsFree(keyword, limit, offset, this.fetcher)
  }

  clearCache(): void {
    this.playlistCache.clear()
    this.playbackCache.clear()
  }
}
