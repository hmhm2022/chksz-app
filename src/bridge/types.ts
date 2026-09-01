import type { PlayerBridge } from '../playerBridge'
import type {
  LibrarySnapshot,
  MusicPlatform,
  NeteasePlaylistSummary,
  PlaybackSource,
  Playlist,
  PlaylistRef,
  Settings,
  Song,
} from '@shared/contracts'
import type { DownloadRecord } from '@shared/storage/downloads-store'

/**
 * window.chksz 全局桥接 API（移动版）。
 *
 * 与桌面版 DesktopApi（chksz-desktop/src/shared/desktop-api.ts）完全同形，
 * 仅额外挂上 player（原生播放桥，桌面版同样暴露但类型在 DesktopApi 里没有）。
 * 移动版 UI（Task 6/7）可直接沿用桌面版的调用方式。
 */
export interface ChkszApi {
  credentials: {
    hasKey(): Promise<boolean>
    validateAndSave(key: string, baseUrl?: string): Promise<void>
  }
  /** 测试 API 连接：验证地址可达性和密钥有效性。 */
  testConnection(baseUrl: string, key: string): Promise<void>
  music: {
    search(platform: MusicPlatform, keyword: string, limit?: number): Promise<Song[]>
    getPlayback(song: Song, quality?: string, forceRefresh?: boolean): Promise<PlaybackSource>
    importNeteasePlaylist(input: string): Promise<Playlist & { saved: boolean }>
    /** 最近导入的网易歌单快照列表（时间倒序）。 */
    savedNeteasePlaylists(): Promise<PlaylistRef[]>
    /** 按歌单 ID 读取本地快照；无缓存则拉取线上并保存。 */
    neteasePlaylistById(id: string, forceRefresh?: boolean): Promise<PlaylistRef>
    /** 精品歌单（精选推荐），免费老接口。分类如"全部"/"华语"，before 为上一页末尾歌单时间戳。 */
    recommendNeteasePlaylists(cat?: string, limit?: number, before?: number): Promise<{ playlists: NeteasePlaylistSummary[]; total: number }>
    /** 全量公开歌单·按热度（分类浏览主体），免费老接口。必须带具体细分类，offset 翻页。 */
    hotNeteasePlaylists(cat: string, limit?: number, offset?: number): Promise<{ playlists: NeteasePlaylistSummary[]; total: number }>
    /** 个性化推荐歌单（feed，每次内容不同），免费免登录。 */
    personalizedPlaylists(limit?: number): Promise<NeteasePlaylistSummary[]>
    /** 官方榜单列表（榜 ID 可直接当歌单打开）。 */
    toplists(): Promise<Array<{ id: string; name: string; cover: string }>>
    /** 搜索公开歌单（搜索发现），免费老接口。返回命中总数（>单页时用于分页）。 */
    searchNeteasePlaylists(keyword: string, limit?: number, offset?: number): Promise<{ playlists: NeteasePlaylistSummary[]; total: number }>
    clearCache(): Promise<void>
    /**
     * 网易云独立免费歌词（不耗额度）。原生自动切歌后由 usePlayer 按需调用补齐歌词展示；
     * QQ/酷狗的歌词已随原生 onTrackAutoAdvanced 事件一并带回，不需要这个方法。
     */
    getNeteaseLyric(songId: string): Promise<{ lyric: string; translatedLyric: string }>
  }
  library: {
    get(): Promise<LibrarySnapshot>
    toggleFavorite(song: Song): Promise<LibrarySnapshot>
    recordPlayed(song: Song): Promise<LibrarySnapshot>
    createPlaylist(name: string): Promise<LibrarySnapshot>
    renamePlaylist(id: string, name: string): Promise<LibrarySnapshot>
    deletePlaylist(id: string): Promise<LibrarySnapshot>
    addSong(playlistId: string, song: Song): Promise<LibrarySnapshot>
    /** 批量添加歌曲（网易云歌单整单复制用）：按 key 去重追加。返回最新快照。 */
    addSongs(playlistId: string, songs: Song[]): Promise<LibrarySnapshot>
    removeSong(playlistId: string, songKey: string): Promise<LibrarySnapshot>
    reorderSong(playlistId: string, from: number, to: number): Promise<LibrarySnapshot>
    clearHistory(): Promise<LibrarySnapshot>
  }
  settings: {
    get(): Promise<Settings>
    update(patch: Partial<Settings>): Promise<Settings>
  }
  downloads: {
    // 移动版无”取消”环节（SystemPlugin 直接把直链写入公共 Download 目录），
    // 状态为 saved/failed，path 为 MediaStore 的 content:// URI。
    // taskId 必传：原生下载异步执行，进度/完成事件按它回推。
    save(song: Song, quality?: string, taskId?: string): Promise<{ status: 'saved' | 'failed'; path?: string }>
    /** 已下载历史记录（时间倒序）。 */
    getHistory(): Promise<DownloadRecord[]>
    /** 已下载歌曲 key 集合（下载按钮已下载禁用态）。 */
    downloadedKeys(): Promise<Set<string>>
    /** 保存一条下载记录（done 落库，按 taskId 去重）。 */
    saveHistory(record: DownloadRecord): Promise<void>
  }
  quota: {
    /** 读展示值：同日返回真实捕获值；跨日或从未捕获 → 回落用户设置的每日额度。 */
    get(): Promise<number | null>
    /** 手动刷新：发一笔最小真实收费请求借响应头刷新额度，消耗 1 次免费额度。返回刷新后的额度。 */
    refresh(): Promise<number | null>
    /** 保存原生取地址响应头带回的免费额度（额度随播放/预解析消耗自动落库刷新）。 */
    save(freeQuota: number): Promise<void>
  }
  player: PlayerBridge
}
