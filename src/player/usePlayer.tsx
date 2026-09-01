import { createContext, use, useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import type { PluginListenerHandle } from '@capacitor/core'
import { type AppErrorCode, type PlaybackSource, type RepeatMode, type Song } from '@shared/contracts'
import { playerBridge, type PlaybackState, type QueueTrackInput } from '../playerBridge'
import { useAppState } from '../app/AppState'
import { initialQueue, queueReducer } from './queue-reducer'
import { DEFAULT_KUGOU_QUALITY, DEFAULT_NETEASE_QUALITY, DEFAULT_QQ_QUALITY } from './quality'

export interface PlayerController {
  queue: ReturnType<typeof queueReducer>
  currentSong: Song | null
  source: PlaybackSource | null
  /** 网易云当前目标音质档位（用户所选项，加载中不随实得档位回跳）。 */
  neteaseQuality: string
  /** QQ / 酷狗当前目标音质档位。 */
  qqQuality: string
  kugouQuality: string
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'error'
  message: string
  /** 最近一次播放失败的 AppError 码（用于错误引导：401 → 去设置换密钥）。无 AppError 信息时为 null。 */
  errorCode: AppErrorCode | null
  currentTime: number
  duration: number
  volume: number
  muted: boolean
  queueOpen: boolean
  lyricsOpen: boolean
  /** 自动跳过提示（整单播放失败自动跳歌时的 toast 文案；空字符串表示无提示）。 */
  skipNotice: string
  playSong(song: Song): void
  playSongs(songs: Song[], index?: number): void
  playNext(song: Song): void
  /** 当前曲目失败后手动重试（重新获取播放地址并加载）。 */
  retry(): void
  toggle(): void
  previous(): void
  next(): void
  seek(value: number): void
  setVolume(value: number): void
  setMuted(value: boolean): void
  setRepeatMode(mode: RepeatMode): void
  selectQuality(quality: string): void
  select(index: number): void
  remove(index: number): void
  reorder(from: number, to: number): void
  clear(): void
  setQueueOpen(value: boolean): void
  setLyricsOpen(value: boolean): void
  /** 关闭最上层播放器浮层（歌词/队列）；有被关闭返回 true。供系统返回键「浮层优先」调用。 */
  closeTopOverlay(): boolean
}

const PlayerContext = createContext<PlayerController | null>(null)

export function PlayerProvider({ children }: { children: ReactNode }) {
  const { state: appState, dispatch: appDispatch, refreshQuota } = useAppState()

  const [queue, queueDispatch] = useReducer(queueReducer, { ...initialQueue, repeatMode: appState.settings?.repeatMode ?? 'sequence' })
  const [source, setSource] = useState<PlaybackSource | null>(null)
  const [status, setStatus] = useState<PlayerController['status']>('idle')
  const [message, setMessage] = useState('')
  const [errorCode, setErrorCode] = useState<AppErrorCode | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolumeState] = useState(appState.settings?.volume ?? 0.8)
  const [muted, setMutedState] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [lyricsOpen, setLyricsOpen] = useState(false)
  const [neteaseQuality, setNeteaseQuality] = useState(appState.settings?.neteaseQuality ?? DEFAULT_NETEASE_QUALITY)
  const [qqQuality, setQqQuality] = useState(appState.settings?.qqQuality ?? DEFAULT_QQ_QUALITY)
  const [kugouQuality, setKugouQuality] = useState(appState.settings?.kugouQuality ?? DEFAULT_KUGOU_QUALITY)
  // 自动跳过 toast：整单播放失败自动跳歌时的短暂提示。用独立状态避免覆盖 message（加载提示）。
  const [skipNotice, setSkipNotice] = useState('')
  const skipNoticeTid = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skippedInitialVolumeSave = useRef(false)
  // 原生 onState/onProgress 只带毫秒级 position，previous()"已播超过 3 秒回开头"需要它。
  const positionRef = useRef(0)
  // 回前台对账用：resume 回调是长生命周期监听器，直接引用 queue 会闭包过期。
  const queueRef = useRef(queue)
  queueRef.current = queue
  /** 最新一次歌词拉取期望的 songKey：快速连切时多个 getNeteaseLyric 并发、响应乱序，
   *  过期响应若照常 setSource 会把新歌歌词覆盖成旧歌的（标题封面对、唯独歌词错的竞态）。
   *  每次发起拉取前登记自己的 key，响应返回后不一致即丢弃。 */
  const lyricExpectKeyRef = useRef<string | null>(null)
  /** 心跳对账去重用：记录已应用过的播放状态,避免每拍重复 applyState('playing') 附带刷额度。 */
  const lastAppliedStateRef = useRef<string | null>(null)
  const currentSong = queue.currentIndex >= 0 ? queue.items[queue.currentIndex] ?? null : null

  /** 把 Song 转为原生队列项（含元数据 + 目标音质，URL 由原生按需解析）。 */
  const toQueueTrackInput = useCallback((song: Song): QueueTrackInput => {
    const quality = song.platform === 'netease' ? neteaseQuality
      : song.platform === 'qq' ? qqQuality : kugouQuality
    return {
      songKey: song.key,
      platform: song.platform,
      songId: song.id,
      quality,
      title: song.name,
      artist: song.artists.join(' / '),
      cover: song.cover || '',
    }
  }, [neteaseQuality, qqQuality, kugouQuality])

  /** 把整条队列推给原生并立即切到 startIndex（原生随即解析地址并播放）：用于真正的"切歌"场景。 */
  const setQueueToNative = useCallback((items: Song[], startIndex: number, mode: RepeatMode) => {
    if (items.length === 0) {
      void playerBridge.stop()
      return
    }
    const inputs = items.map(toQueueTrackInput)
    void playerBridge.setQueue(inputs, startIndex, mode).catch(err => {
      console.error('[usePlayer] setQueue failed:', err)
      setStatus('error')
      setMessage(err instanceof Error ? err.message : '设置队列失败')
    })
  }, [toQueueTrackInput])

  /**
   * 只同步队列数据到原生，不触发播放（不 load/play，当前播放不受影响）：
   * 用于插队下一首/拖拽排序/删除非当前项这类"编辑队列但不该打断当前播放"的场景。
   */
  const updateQueueOnNative = useCallback((items: Song[], currentIndex: number) => {
    const inputs = items.map(toQueueTrackInput)
    void playerBridge.updateQueueItems(inputs, currentIndex).catch(err => {
      console.error('[usePlayer] updateQueueItems failed:', err)
    })
  }, [toQueueTrackInput])

  /** 整单播放自动跳过时会调用：展示 toast 提示（不打断播放）。 */
  const showSkipNotice = useCallback((text: string) => {
    setSkipNotice(text)
    if (skipNoticeTid.current) clearTimeout(skipNoticeTid.current)
    skipNoticeTid.current = setTimeout(() => setSkipNotice(''), 2500)
  }, [])

  /** 跳过后 toast 立即隐去，避免残留。 */
  const dismissSkipNotice = useCallback(() => {
    if (skipNoticeTid.current) clearTimeout(skipNoticeTid.current)
    skipNoticeTid.current = null
    setSkipNotice('')
  }, [])

  // 状态应用统一入口：onState 推送、getState 补拉、回前台对账三条通道共用，行为一致。
  const applyState = useCallback((state: PlaybackState, message?: string) => {
    if (state === 'playing') {
      setStatus('playing')
      setMessage('')
      setErrorCode(null)
      dismissSkipNotice()
      void refreshQuota()
    } else if (state === 'paused') {
      setStatus('paused')
    } else if (state === 'loading') {
      setStatus('loading')
      setMessage('正在加载')
    } else if (state === 'idle') {
      setStatus('idle')
    } else if (state === 'error') {
      // 原生 ERROR 态如实上报（此前伪装 paused 导致 UI 毫无感知）：展示错误态，
      // 用户点播放经 toggle 走 retry 重新解析地址恢复。
      setStatus('error')
      setMessage(message || '该歌曲暂时无法播放')
    }
    // ended 事件不再由 JS 处理（原生自己切下一首），这里忽略。
  }, [dismissSkipNotice, refreshQuota])

  // 全局订阅原生事件（onState/onProgress/onError/onTrackAutoAdvanced/onQueueEnded），
  // 不依赖 currentSong key（原生自己管切歌），整个 Provider 生命周期只注册一次。
  useEffect(() => {
    const subscriptions: { cancelled: boolean; cleanup: Array<() => void> } = { cancelled: false, cleanup: [] }
    const subscribe = (handlePromise: Promise<PluginListenerHandle>) => {
      void handlePromise.then(handle => {
        if (subscriptions.cancelled) void handle.remove()
        else subscriptions.cleanup.push(() => { void handle.remove() })
      })
    }

    subscribe(playerBridge.onState((event) => applyState(event.state, event.message)))

    subscribe(playerBridge.onProgress((event) => {
      const position = (event.currentPosition ?? 0) / 1000
      positionRef.current = position
      setCurrentTime(position)
      if (event.duration != null && event.duration > 0) {
        setDuration(event.duration / 1000)
      }
    }))

    subscribe(playerBridge.onError((event) => {
      // 原生播放失败（整单播放时原生已自动跳下一首，这里只收错误信息展示 toast）。
      // 非整单播放时原生会停在当前项，UI 展示 error 状态供用户 retry。
      setStatus('error')
      setMessage(event.message || '该歌曲暂时无法播放')
      setErrorCode(null)
      // 整单播放时展示跳过提示（原生已自动跳下一首）
      if (queue.queuePlay && currentSong) {
        showSkipNotice(`已自动跳过不可播放的「${currentSong.name}」`)
      }
    }))

    // 原生自动/手动切歌后回推：同步 JS 队列 currentIndex + 拉歌词 + 记录播放历史。
    subscribe(playerBridge.onTrackAutoAdvanced(async (event) => {
      // 同步 JS 队列索引（不触发重新 setQueue，因为原生已经在播这一首了）
      queueDispatch({ type: 'select', index: event.index })
      const song = queue.items[event.index]
      if (!song) return

      // 切歌瞬间立即归零进度：不能让 UI 用上一首的 currentTime/duration 渲染比例。
      // （原生会在新歌的 onProgress 到达前不推位置，这里主动复位避免"旧歌进度残留"）
      setCurrentTime(0)
      setDuration(0)
      positionRef.current = 0

      // 登记本次期望的曲目：无论歌词来自原生自带还是异步拉取，setSource 前都要校验，
      // 防止快速连切时过期响应覆盖新歌歌词（见 lyricExpectKeyRef 注释）。
      lyricExpectKeyRef.current = song.key

      // 歌词：QQ/酷狗随原生取址一并解析（event.lyric 非空），网易云为空串需补齐。
      let lyric = event.lyric
      let translatedLyric = ''
      if (!lyric && song.platform === 'netease') {
        try {
          const result = await window.chksz.music.getNeteaseLyric(song.id)
          lyric = result.lyric
          translatedLyric = result.translatedLyric
        } catch {
          lyric = ''
        }
      }
      // 拉取期间又切了歌：本次响应已过期，丢弃（最新一次处理负责 setSource）。
      if (lyricExpectKeyRef.current !== song.key) return
      // 构造 PlaybackSource 供歌词展示（url/format 已由原生播放，UI 只需 lyric 字段）
      setSource({ songKey: song.key, url: '', quality: '', format: null, lyric, translatedLyric })

      // 记录播放历史（首次播放时触发，切歌也触发）
      void window.chksz.library.recordPlayed(song).then(library => appDispatch({ type: 'libraryChanged', library }))
    }))

    // 队列播完（sequence 到尾且非循环）：原生推这个事件，JS 调 stop() 并复位 UI。
    subscribe(playerBridge.onQueueEnded(() => {
      void playerBridge.stop()
      setStatus('idle')
      setMessage('')
      dismissSkipNotice()
    }))

    // 额度自动刷新：原生取地址（播放/预解析）响应头带回的免费额度剩余，落库供展示。
    subscribe(playerBridge.onQuota(async (event) => {
      try {
        await window.chksz.quota.save(event.freeQuota)
        appDispatch({ type: 'quotaUpdated', freeQuota: event.freeQuota })
      } catch {
        // 额度落库失败不影响播放，静默忽略。
      }
    }))

    // 订阅空窗补偿：本 effect 依赖变化（切歌等）时会"注销→异步重注册"，空窗期的
    // onState/onProgress 推送永久丢失（onError 一次性事件同理）。重订阅完成后主动
    // 拉一次原生快照补齐，状态不再依赖"恰好没丢"。
    void playerBridge.getState().then((snapshot) => {
      if (!snapshot) return
      applyState(snapshot.state, snapshot.message)
      const position = (snapshot.currentPosition ?? 0) / 1000
      positionRef.current = position
      setCurrentTime(position)
      if (snapshot.duration != null && snapshot.duration > 0) {
        setDuration(snapshot.duration / 1000)
      }
    }).catch(() => {})

    return () => {
      subscriptions.cancelled = true
      for (const cleanup of subscriptions.cleanup) cleanup()
    }
  }, [queue.items, queue.queuePlay, currentSong, refreshQuota, showSkipNotice, dismissSkipNotice, appDispatch, applyState])

  // 回前台/心跳对账：熄屏期间 WebView 冻结会吞掉 onTrackAutoAdvanced/onError 等推送事件,
  // 原生已切歌而 JS 队列索引/封面/歌词停在旧曲(用户看到"声音是下一首、封面歌词还是上一首")。
  // 对账拉原生快照全量对齐——进度/状态照常应用;若原生索引与 JS 不一致,说明发生过未被
  // 感知的切歌:同步索引 + 用快照带回的元数据/歌词重建 source(网易云歌词原生为空串,走
  // 免费接口补齐),并补记播放历史。
  const reconcileWithNative = useCallback((isCancelled: () => boolean) => {
    void playerBridge.getState().then(async (snap) => {
      if (isCancelled() || !snap) return
      // 状态去重后才应用:心跳每 10s 拿到的 state 多数时候不变,而 applyState('playing')
      // 会附带 refreshQuota()——不去重会把额度接口打成 10 秒一刷。
      if (lastAppliedStateRef.current !== snap.state) {
        lastAppliedStateRef.current = snap.state
        applyState(snap.state, snap.message)
      } else if (snap.state === 'error') {
        // error 态消息可能随快照更新(同状态下 message 变化),仅刷新文案不动其他逻辑
        if (snap.message) setMessage(snap.message)
      }
      const position = (snap.currentPosition ?? 0) / 1000
      positionRef.current = position
      setCurrentTime(position)
      if (snap.duration != null && snap.duration > 0) {
        setDuration(snap.duration / 1000)
      }
      const nativeIndex = snap.currentIndex
      if (nativeIndex == null || nativeIndex < 0 || nativeIndex === queueRef.current.currentIndex) return
      const song = queueRef.current.items[nativeIndex]
      if (!song) return
      queueDispatch({ type: 'select', index: nativeIndex })
      setCurrentTime(0)
      setDuration(0)
      positionRef.current = 0
      let lyric = snap.lyric ?? ''
      let translatedLyric = ''
      if (song.platform === 'netease') {
        lyricExpectKeyRef.current = song.key
        try {
          const result = await window.chksz.music.getNeteaseLyric(song.id)
          lyric = result.lyric
          translatedLyric = result.translatedLyric
        } catch {
          lyric = ''
        }
      }
      // 拉取期间状态又变了(切歌/再次熄屏):过期结果丢弃,防止覆盖最新歌词。
      if (isCancelled() || lyricExpectKeyRef.current !== song.key) return
      setSource({ songKey: song.key, url: '', quality: '', format: null, lyric, translatedLyric })
      void window.chksz.library.recordPlayed(song).then(library => appDispatch({ type: 'libraryChanged', library })).catch(() => {})
    }).catch(() => {})
  }, [applyState, appDispatch])

  useEffect(() => {
    let cancelled = false
    const isCancelled = () => cancelled
    // 触发点 1:appStateChange(原生桥)。注意它在亮屏瞬间推送时 WebView 可能仍在解冻,
    // 该通知本身偶发丢失——所以它只是"提前触发",不是唯一保障。
    const handle = CapacitorApp.addListener('appStateChange', (state) => {
      if (!state.isActive || cancelled) return
      reconcileWithNative(isCancelled)
    })
    // 触发点 2:visibilitychange(Web API)。WebView 解冻后浏览器必发此事件,不走原生桥、
    // 不会丢——覆盖"亮屏通知被吞"的场景。
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !cancelled) reconcileWithNative(isCancelled)
    }
    document.addEventListener('visibilitychange', onVisibility)
    // 触发点 3:10 秒心跳(仅前台可见时跑)。任何事件链断裂(冻结/解冻窗口/订阅空窗)
    // 最多滞后一个周期必然收敛;熄屏时系统暂停定时器,零功耗。对账幂等,重复执行无害。
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible' || cancelled) return
      reconcileWithNative(isCancelled)
    }, 10000)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      clearInterval(timer)
      void handle.then(h => h.remove()).catch(() => {})
    }
  }, [reconcileWithNative])

  // 通知栏/锁屏元数据：currentSong 变化时把标题/艺术家/封面推给原生（切歌后随新 MediaItem 展示）。
  // 无 currentSong（队列清空）时不推空元数据，避免清掉通知栏里仍在播放的曲目信息。
  useEffect(() => {
    if (!currentSong) return
    void playerBridge
      .updateMetadata(currentSong.name, currentSong.artists.join(' / '), currentSong.cover || null)
      .catch(() => {})
  }, [currentSong?.key])

  // 通知栏"上一曲/下一曲"+ 耳机线控命令：原生 CommandBridgePlayer 拦截系统命令回推给 JS。
  // 注意：原生 seekToNext/seekToPrevious 不转发给 ExoPlayer（单曲无媒体项可切），
  // 只回推 onCommand 给 JS，由 JS 调 playerBridge.next/previous 触发原生切歌逻辑。
  useEffect(() => {
    const subscriptions: { cancelled: boolean; cleanup: Array<() => void> } = { cancelled: false, cleanup: [] }
    const subscribe = (handlePromise: Promise<PluginListenerHandle>) => {
      void handlePromise.then(handle => {
        if (subscriptions.cancelled) void handle.remove()
        else subscriptions.cleanup.push(() => { void handle.remove() })
      })
    }
    subscribe(playerBridge.onCommand((event) => {
      if (event.command === 'next') {
        void playerBridge.next()
      } else if (event.command === 'prev') {
        // 与 controller.previous 语义一致：已播超 3 秒先回开头，否则上一曲。
        if (positionRef.current > 3) {
          positionRef.current = 0
          setCurrentTime(0)
          void playerBridge.seek(0).catch(() => {})
        } else {
          void playerBridge.previous()
        }
      }
    }))
    return () => {
      subscriptions.cancelled = true
      for (const cleanup of subscriptions.cleanup) cleanup()
    }
  }, [])

  // 音量/静音随时推给原生播放器。
  useEffect(() => {
    const native = () => void playerBridge.setVolume(muted ? 0 : volume).catch(() => {})
    native()
  }, [volume, muted])

  // 循环模式变化时同步给原生（不影响当前播放，下一次切歌时生效）。
  useEffect(() => {
    void playerBridge.setRepeatMode(queue.repeatMode).catch(() => {})
  }, [queue.repeatMode])

  useEffect(() => {
    // Escape 关闭歌词 / 队列等浮层，避免误入后找不到退出入口。
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setLyricsOpen(false)
      setQueueOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    const settings = appState.settings
    if (!settings) return
    setVolumeState(settings.volume)
    setNeteaseQuality(settings.neteaseQuality)
    setQqQuality(settings.qqQuality ?? DEFAULT_QQ_QUALITY)
    setKugouQuality(settings.kugouQuality ?? DEFAULT_KUGOU_QUALITY)
    queueDispatch({ type: 'setRepeatMode', mode: settings.repeatMode })
  }, [appState.settings?.volume, appState.settings?.neteaseQuality, appState.settings?.qqQuality, appState.settings?.kugouQuality, appState.settings?.repeatMode])

  useEffect(() => {
    if (!skippedInitialVolumeSave.current) {
      skippedInitialVolumeSave.current = true
      return
    }
    const timer = window.setTimeout(() => {
      void window.chksz.settings.update({ volume }).then(settings => appDispatch({ type: 'settingsChanged', settings }))
    }, 350)
    return () => window.clearTimeout(timer)
  }, [volume, appDispatch])

  /** 重试当前曲目：重新推队列（startIndex 不变），原生会重新解析播放地址。 */
  const retryPlayback = () => {
    setQueueToNative(queue.items, queue.currentIndex, queue.repeatMode)
  }

  const controller: PlayerController = {
    queue,
    currentSong,
    source,
    neteaseQuality,
    qqQuality,
    kugouQuality,
    status,
    message,
    errorCode,
    currentTime,
    duration,
    volume,
    muted,
    queueOpen,
    lyricsOpen,
    skipNotice,
    playSong: (song) => {
      queueDispatch({ type: 'replace', items: [song] })
      // 立即推给原生（startIndex=0，非整单播放）
      setQueueToNative([song], 0, queue.repeatMode)
    },
    playSongs: (songs, index = 0) => {
      queueDispatch({ type: 'replace', items: songs, index, queuePlay: true })
      // 立即推给原生（startIndex=index，整单播放）
      setQueueToNative(songs, index, queue.repeatMode)
    },
    playNext: (song) => {
      queueDispatch({ type: 'playNext', song })
      // 插队不打断当前播放：只同步数据，currentIndex 不变，下一首变了。
      const newItems = [...queue.items.slice(0, queue.currentIndex + 1), song, ...queue.items.slice(queue.currentIndex + 1)]
      updateQueueOnNative(newItems, queue.currentIndex)
    },
    retry: retryPlayback,
    toggle: () => {
      if (!currentSong) return
      // error 态下原生裸 play() 无效（ExoPlayer ERROR 必须 setMediaItem+prepare 才能恢复）：
      // 改走重试重新推队列解析地址，这才是用户点"播放"时的预期行为。
      if (status === 'error') {
        retryPlayback()
        return
      }
      void (status === 'playing' ? playerBridge.pause() : playerBridge.play()).catch(() => {})
    },
    previous: () => {
      if (positionRef.current > 3) {
        positionRef.current = 0
        setCurrentTime(0)
        void playerBridge.seek(0).catch(() => {})
      } else {
        void playerBridge.previous()
      }
    },
    next: () => void playerBridge.next(),
    seek: (value) => {
      const seconds = Math.max(0, value)
      setCurrentTime(seconds)
      positionRef.current = seconds
      void playerBridge.seek(Math.round(seconds * 1000)).catch(() => {})
    },
    setVolume: (value) => setVolumeState(Math.min(1, Math.max(0, value))),
    setMuted: setMutedState,
    setRepeatMode: (mode) => {
      queueDispatch({ type: 'setRepeatMode', mode })
      void window.chksz.settings.update({ repeatMode: mode }).then(settings => appDispatch({ type: 'settingsChanged', settings }))
    },
    selectQuality: (value) => {
      if (value === (currentSong?.platform === 'netease' ? neteaseQuality : currentSong?.platform === 'qq' ? qqQuality : kugouQuality)) return
      if (currentSong?.platform === 'netease') {
        setNeteaseQuality(value)
        void window.chksz.settings.update({ neteaseQuality: value }).then(settings => appDispatch({ type: 'settingsChanged', settings }))
      } else if (currentSong?.platform === 'qq') {
        setQqQuality(value)
        void window.chksz.settings.update({ qqQuality: value }).then(settings => appDispatch({ type: 'settingsChanged', settings }))
      } else {
        setKugouQuality(value)
        void window.chksz.settings.update({ kugouQuality: value }).then(settings => appDispatch({ type: 'settingsChanged', settings }))
      }
      // 音质变化后立即重新推队列（原生会重新解析所有曲目地址）
      setQueueToNative(queue.items, queue.currentIndex, queue.repeatMode)
    },
    select: (index) => {
      queueDispatch({ type: 'select', index })
      // 手动选曲后立即推给原生（startIndex=index）
      setQueueToNative(queue.items, index, queue.repeatMode)
    },
    remove: (index) => {
      queueDispatch({ type: 'remove', index })
      const newItems = queue.items.filter((_, i) => i !== index)
      const removingCurrent = index === queue.currentIndex
      const newIndex = index < queue.currentIndex ? queue.currentIndex - 1
        : removingCurrent ? Math.max(0, Math.min(queue.currentIndex, newItems.length - 1))
        : queue.currentIndex
      // 删除的正是当前播放项：这才是真正的"切歌"，需要触发原生重新解析+播放；
      // 删除其他项只是列表变化，当前播放不受影响，只同步数据。
      if (removingCurrent && newItems.length > 0) setQueueToNative(newItems, newIndex, queue.repeatMode)
      else if (newItems.length === 0) setQueueToNative(newItems, newIndex, queue.repeatMode)
      else updateQueueOnNative(newItems, newIndex)
    },
    reorder: (from, to) => {
      queueDispatch({ type: 'reorder', from, to })
      // 拖拽排序不改变"正在播放的是哪一首"，只是位置变化：只同步数据，不打断播放。
      const newItems = [...queue.items]
      const [moved] = newItems.splice(from, 1)
      newItems.splice(to, 0, moved)
      const newIndex = queue.currentIndex === from ? to
        : from < queue.currentIndex && to >= queue.currentIndex ? queue.currentIndex - 1
        : from > queue.currentIndex && to <= queue.currentIndex ? queue.currentIndex + 1
        : queue.currentIndex
      updateQueueOnNative(newItems, newIndex)
    },
    clear: () => {
      queueDispatch({ type: 'replace', items: [] })
      void playerBridge.stop()
    },
    setQueueOpen,
    setLyricsOpen,
    /** 关掉最上层播放器浮层（歌词优先于队列，见 usePlayer 浮层语义）。 */
    closeTopOverlay: () => {
      if (lyricsOpen) {
        setLyricsOpen(false)
        return true
      }
      if (queueOpen) {
        setQueueOpen(false)
        return true
      }
      return false
    },
  }
  return <PlayerContext value={controller}>{children}</PlayerContext>
}

export function usePlayer(): PlayerController {
  const value = use(PlayerContext)
  if (!value) throw new Error('PlayerProvider is missing')
  return value
}
