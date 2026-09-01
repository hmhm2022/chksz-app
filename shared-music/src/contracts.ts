export type MusicPlatform = 'netease' | 'qq' | 'kugou'
export type RepeatMode = 'sequence' | 'list' | 'one' | 'shuffle'

export interface Song {
  key: string
  platform: MusicPlatform
  id: string
  name: string
  artists: string[]
  album: string
  cover: string
  duration: number | null
  qualities: string[]
}

export interface PlaybackSource {
  songKey: string
  url: string
  quality: string
  format: string | null
  lyric: string
  translatedLyric: string
  /** 歌词加载失败时的用户提示（免费歌词源不可用）。非空时 UI 显示此文案而非「暂无歌词」。 */
  lyricError?: string
}

export interface Playlist {
  id: string
  name: string
  cover: string
  creator: string
  songs: Song[]
}

/** 公开歌单摘要（精选推荐 / 搜索发现用）。点卡片后再拉完整曲目。 */
export interface NeteasePlaylistSummary {
  id: string
  name: string
  cover: string
  creator: string
  playCount: number
  trackCount: number
  /** 歌单更新时间戳，精品歌单分页（before 游标）用。 */
  updateTime: number
}

export interface Settings {
  defaultPlatform: MusicPlatform
  neteaseQuality: string
  qqQuality: string
  kugouQuality: string
  downloadDirectory: string
  volume: number
  repeatMode: RepeatMode
  showCoverArt: boolean
  /** 网易云搜索是否使用免费老接口；关闭则走 ChKSz。免费用尽/失效时可切换。 */
  neteaseSearchFree: boolean
  /** QQ 搜索是否使用免费接口；关闭则走 ChKSz。免费源失效时提示到设置关闭（与网易云同语义）。 */
  qqSearchFree: boolean
  /** 酷狗搜索是否使用免费接口；关闭则走 ChKSz。免费源失效时提示到设置关闭（与网易云同语义）。 */
  kugouSearchFree: boolean
  /** 用户设定的每日免费额度。跨日后、尚未捕获到新响应头时兜底展示（非精确真实值）。 */
  dailyQuota: number
  /** ChKSz API 网关基址；为空时使用默认地址。 */
  apiBaseUrl: string
}

/** 我创建/维护的歌单。source=custom 是手动收录；source=netease 是对某个网易云歌单的"引用"快照。 */
export interface LocalPlaylist {
  id: string
  name: string
  songs: Song[]
  createdAt: string
  updatedAt: string
  source: 'netease' | 'custom'
  /** 网易云歌单 ID；仅 source=netease 时有值。 */
  sourceId: string | null
}

/** 资料库里保存的网易歌单引用（元信息 + 曲目快照，便于秒开 + 后台刷新）。 */
export interface PlaylistRef {
  id: string
  sourceId: string
  name: string
  cover: string
  creator: string
  songCount: number
  songs: Song[]
  /** 上次拉取快照的时间。 */
  updatedAt: string
  /** 本快照来自哪个数据源（免费网易老接口 / ChKSz 收费接口）。 */
  source: 'free' | 'chksz'
}

export interface LibrarySnapshot {
  favorites: Song[]
  history: Song[]
  playlists: LocalPlaylist[]
  /** 最近导入的网易歌单快照，按时间倒序，最多 10 个。 */
  neteaseImports: PlaylistRef[]
}

export type AppErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'RATE_WAIT'
  | 'NETWORK'
  | 'NOT_PLAYABLE'
  | 'STORAGE'
  | 'DOWNLOAD'

export interface AppErrorShape {
  code: AppErrorCode
  message: string
}

export class AppError extends Error {
  readonly code: AppErrorCode

  constructor(shape: AppErrorShape) {
    super(shape.message)
    this.name = 'AppError'
    this.code = shape.code
  }
}
