import { registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import type { MusicPlatform, RepeatMode } from '@shared/contracts'

/**
 * 播放状态。'error' 是 onError 事件单独推送的，
 * onState 只推 idle/loading/playing/paused/ended。
 */
export type PlaybackState =
  | 'idle'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error'

export interface PlayerEvent {
  state: PlaybackState
  message?: string
  currentPosition?: number
  duration?: number
  /** getState() 附带：原生逻辑队列当前索引（回前台对账用，熄屏冻结可能吞掉切歌事件）。 */
  currentIndex?: number
  /** getState() 附带：原生当前媒体项的 songKey（与 currentIndex 交叉校验）。 */
  currentSongKey?: string
  /** getState() 附带：原生队列当前项元数据（QQ/酷狗歌词随解析缓存；网易云歌词为空串需 JS 补齐）。 */
  title?: string
  artist?: string
  cover?: string
  lyric?: string
}

/** 原生通知栏/耳机线控下发的命令。原生现在自己持队列，next/prev 直接由原生执行并回推 onTrackAutoAdvanced。 */
export type PlayerCommand = 'next' | 'prev'

export interface PlayerCommandEvent {
  command: PlayerCommand
}

/** 交给原生的一条队列项：曲目元数据 + 目标音质，URL 由原生按需解析（不在 JS 侧预解析）。 */
export interface QueueTrackInput {
  songKey: string
  platform: MusicPlatform
  songId: string
  quality: string
  title: string
  artist: string
  cover: string
}

/** 原生自动/手动切歌后回推：告诉 JS 当前播的是队列第几项，UI 据此同步歌词/高亮/收藏记录。 */
export interface TrackAdvancedEvent {
  songKey: string
  index: number
  /** QQ/酷狗歌词随原生取址一并解析（不重复耗额度）；网易云为空串，JS 侧走独立免费接口补齐。 */
  lyric: string
}

/** 原生取地址响应头带回的免费额度剩余（每次播放/预解析都刷新）。 */
export interface QuotaEvent {
  freeQuota: number
}

/**
 * WebView 侧使用的播放桥 API（域名风格）。
 * 事件监听返回 PluginListenerHandle，记得在卸载时调用 handle.remove()。
 */
export interface PlayerBridge {
  load(url: string): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seek(positionMs: number): Promise<void>
  setVolume(volume: number): Promise<void>
  /** 通知栏/锁屏展示的元数据（标题/艺术家/封面）。currentSong 变化时调用。 */
  updateMetadata(title: string, artist: string, coverUrl: string | null): Promise<void>
  /**
   * 队列播完（无下一首）时调用：暂停并停掉原生前台服务。
   * 与旧的「播完即停」不同——跨曲交接瞬间不会停服务（避免后台进程被杀），
   * 只有 JS 确认队列真播完才主动停。下次 play() 会重新拉起。幂等。
   */
  stop(): Promise<void>
  /**
   * 把整条播放队列一次性交给原生：原生随即解析 startIndex 曲目地址并播放，
   * 此后每首播完（ENDED）由原生自己解析下一首地址续播，不依赖 JS——
   * 这是后台跨曲交接的根治点（WebView 后台被系统冻结时 JS 不响应，原生仍可独立运行）。
   */
  setQueue(items: QueueTrackInput[], startIndex: number, repeatMode: RepeatMode): Promise<void>
  /** 切换循环模式（不影响当前播放，下一次切歌时生效）。 */
  setRepeatMode(mode: RepeatMode): Promise<void>
  /** 手动下一曲（原生按 repeatMode 计算目标并自行切歌）。 */
  next(): Promise<void>
  /** 手动上一曲（"已播超 3 秒回开头"的判断仍在 JS 侧，回开头就调 seek，否则调这个）。 */
  previous(): Promise<void>
  /**
   * 拉取当前播放状态快照（state/currentPosition/duration/错误消息）。
   * 推送事件在订阅重建空窗期会丢；重订阅完成后调它补齐，不依赖"恰好没丢"。
   */
  getState(): Promise<PlayerEvent>
  /**
   * 只同步队列内容/当前索引，不触发任何播放动作（不 load、不 play）。
   * 用于插队下一首/拖拽排序/删除非当前项等"编辑队列但不该打断当前播放"的场景，
   * 原生 ENDED 时会用最新数据计算下一首。
   */
  updateQueueItems(items: QueueTrackInput[], currentIndex: number): Promise<void>

  onState(callback: (event: PlayerEvent) => void): Promise<PluginListenerHandle>
  onProgress(callback: (event: PlayerEvent) => void): Promise<PluginListenerHandle>
  onError(callback: (event: PlayerEvent) => void): Promise<PluginListenerHandle>
  /** 通知栏“上一曲/下一曲”、耳机线控触发的命令（原生已自行切歌，这里仅用于 UI 参考，非必须处理）。 */
  onCommand(callback: (event: PlayerCommandEvent) => void): Promise<PluginListenerHandle>
  /** 原生自动或手动切歌完成后回推：JS 据此同步 currentIndex + 拉歌词/记录播放历史。 */
  onTrackAutoAdvanced(callback: (event: TrackAdvancedEvent) => void): Promise<PluginListenerHandle>
  /** 队列播完（sequence 到尾且非循环）：JS 收到后应调 stop() 并复位 UI。 */
  onQueueEnded(callback: () => void): Promise<PluginListenerHandle>
  /** 原生取地址响应头带回的免费额度剩余：JS 接收到落库，额度随播放消耗自动刷新。 */
  onQuota(callback: (event: QuotaEvent) => void): Promise<PluginListenerHandle>
}

/**
 * 原生插件代理的真实类型：
 * - 方法参数是 options 对象（Capacitor 序列化约定）
 * - 额外带 addListener，用于订阅原生事件
 */
interface NativePlayerPlugin {
  load(options: { url: string }): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  stop(): Promise<void>
  seek(options: { positionMs: number }): Promise<void>
  setVolume(options: { volume: number }): Promise<void>
  updateMetadata(options: { title: string; artist: string; coverUrl: string | null }): Promise<void>
  setQueue(options: { items: QueueTrackInput[]; startIndex: number; repeatMode: RepeatMode }): Promise<void>
  setRepeatMode(options: { mode: RepeatMode }): Promise<void>
  next(): Promise<void>
  previous(): Promise<void>
  getState(options?: Record<string, never>): Promise<PlayerEvent>
  updateQueueItems(options: { items: QueueTrackInput[]; currentIndex: number }): Promise<void>
  addListener(eventName: 'onState' | 'onProgress' | 'onError', listener: (event: PlayerEvent) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'onCommand', listener: (event: PlayerCommandEvent) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'onTrackAutoAdvanced', listener: (event: TrackAdvancedEvent) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'onQueueEnded', listener: () => void): Promise<PluginListenerHandle>
  addListener(eventName: 'onQuota', listener: (event: QuotaEvent) => void): Promise<PluginListenerHandle>
}

const PlayerPlugin = registerPlugin<NativePlayerPlugin>('PlayerPlugin')

/**
 * 播放桥实例：WebView 侧唯一入口，供 React UI 调用。
 */
export const playerBridge: PlayerBridge = {
  load: (url) => PlayerPlugin.load({ url }),
  play: () => PlayerPlugin.play(),
  pause: () => PlayerPlugin.pause(),
  stop: () => PlayerPlugin.stop(),
  seek: (positionMs) => PlayerPlugin.seek({ positionMs }),
  setVolume: (volume) => PlayerPlugin.setVolume({ volume }),
  updateMetadata: (title, artist, coverUrl) => PlayerPlugin.updateMetadata({ title, artist, coverUrl }),
  setQueue: (items, startIndex, repeatMode) => PlayerPlugin.setQueue({ items, startIndex, repeatMode }),
  setRepeatMode: (mode) => PlayerPlugin.setRepeatMode({ mode }),
  next: () => PlayerPlugin.next(),
  previous: () => PlayerPlugin.previous(),
  getState: () => PlayerPlugin.getState(),
  updateQueueItems: (items, currentIndex) => PlayerPlugin.updateQueueItems({ items, currentIndex }),

  onState: (cb) => PlayerPlugin.addListener('onState', cb),
  onProgress: (cb) => PlayerPlugin.addListener('onProgress', cb),
  onError: (cb) => PlayerPlugin.addListener('onError', cb),
  onCommand: (cb) => PlayerPlugin.addListener('onCommand', cb),
  onTrackAutoAdvanced: (cb) => PlayerPlugin.addListener('onTrackAutoAdvanced', cb),
  onQueueEnded: (cb) => PlayerPlugin.addListener('onQueueEnded', cb),
  onQuota: (cb) => PlayerPlugin.addListener('onQuota', cb),
}

export default playerBridge
