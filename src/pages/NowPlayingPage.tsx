import { useEffect, useRef, useState } from 'react'
import { activeLyricIndex, parseLrc } from '../player/lrc'
import { usePlayer } from '../player/usePlayer'
import { useDownloads } from '../downloads/store'
import { neteaseQualityOptions, qqQualityOptions, kugouQualityOptions } from '../player/quality'
import type { RepeatMode } from '@shared/contracts'
import { ErrorNotice } from '../components/ErrorNotice'
import { BackIcon, DownloadIcon, LoaderIcon, PauseIcon, PlayIcon } from '../components/icons'
import { useOverlayRegistry } from '../app/overlays'

/** mm:ss 格式化进度。 */
const time = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`

/** 循环模式图标：顺序/列表/单曲/随机。 */
const RepeatGlyph = {
  sequence: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </svg>
  ),
  list: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </svg>
  ),
  one: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
    </svg>
  ),
  shuffle: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.8-1.1 2-1.7 3.3-1.7H22" />
      <path d="m18 2 4 4-4 4" />
      <path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2" />
      <path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8" />
      <path d="m18 14 4 4-4 4" />
    </svg>
  ),
} as const

const REPEAT_ORDER: RepeatMode[] = ['sequence', 'list', 'one', 'shuffle']
const REPEAT_LABEL: Record<RepeatMode, string> = { sequence: '顺序播放', list: '列表循环', one: '单曲循环', shuffle: '随机播放' }

/** 音质档位（按当前曲目平台取对应列表）。 */
const qualityOptions = (platform: string): { value: string; label: string }[] =>
  platform === 'netease' ? neteaseQualityOptions() : platform === 'qq' ? qqQualityOptions() : kugouQualityOptions()

/**
 * NowPlayingPage —— 全屏播放页（沉浸模式，隐藏 TabBar）。
 * 顶部后退 + 大封面（无图渐变占位）+ 曲名/歌手；
 * 歌词滚动高亮（可手动滚动，5 秒后自动跟随）；可拖进度条 + 当前/总时长；
 * 底部控制区：循环 / 上一首 / 播放暂停 / 下一首 / 音量 / 音质。
 */
export function NowPlayingPage({ onClose, onOpenSettings }: { onClose: () => void; onOpenSettings?: () => void }) {
  const player = usePlayer()
  const downloads = useDownloads()
  const overlays = useOverlayRegistry()
  const { currentSong, status, source, errorCode, currentTime, duration, volume, muted } = player
  const lines = parseLrc(source?.lyric ?? '')
  const translated = parseLrc(source?.translatedLyric ?? '')
  const active = activeLyricIndex(lines, currentTime)
  const lineRefs = useRef<Array<HTMLParagraphElement | null>>([])
  const [manualUntil, setManualUntil] = useState(0)
  /** 音质选择是否展开。 */
  const [qualityOpen, setQualityOpen] = useState(false)
  const [volumeOpen, setVolumeOpen] = useState(false)
  /** 进度条拖拽中的临时值（仅驱动 UI，松手才真正 seek）；null 表示未在拖拽。 */
  const [scrub, setScrub] = useState<number | null>(null)
  /** scrub 的同步 ref：超时自动提交的定时器回调里读到最新值（state 闭包会过期）。 */
  const scrubRef = useRef<number | null>(null)
  /** 超时自动提交定时器：WebView 上 range 的 pointerup 偶发丢失，scrub 残留会把进度条钉死。 */
  const scrubTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 防重复点击：正在下载的歌曲 key（同步写入 ref，比 tasks state 更早生效）。 */
  const downloadingKeyRef = useRef<Set<string>>(new Set())

  // 切歌时清掉拖拽残留：scrub 跨曲残留会让新歌进度条冻结在旧值上。
  useEffect(() => {
    scrubRef.current = null
    setScrub(null)
    if (scrubTimerRef.current) {
      clearTimeout(scrubTimerRef.current)
      scrubTimerRef.current = null
    }
  }, [currentSong?.key])

  useEffect(() => {
    // 切歌 / loading 时先收起音质与音量弹层，避免残留指向旧曲目面板。
    setQualityOpen(false)
    setVolumeOpen(false)
  }, [currentSong?.key, status])

  // 音质/音量弹层注册进全局 overlay 注册表：返回键先关顶层浮层（不触达页面导航）。
  // close 回调 = 组件内关（setXxxOpen(false)），切歌/卸载时经 cleanup 自动注销。
  useEffect(() => qualityOpen ? overlays.register({ id: 'now-playing-quality', close: () => setQualityOpen(false) }) : undefined, [qualityOpen, overlays])
  useEffect(() => volumeOpen ? overlays.register({ id: 'now-playing-volume', close: () => setVolumeOpen(false) }) : undefined, [volumeOpen, overlays])

  useEffect(() => {
    if (Date.now() >= manualUntil && active >= 0) {
      lineRefs.current[active]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [active, manualUntil])

  const advanceRepeat = () => {
    const next = REPEAT_ORDER[(REPEAT_ORDER.indexOf(player.queue.repeatMode) + 1) % REPEAT_ORDER.length]!
    player.setRepeatMode(next)
  }

  /** 进度条拖动完成：真正 seek 并清空临时值（键盘输入走 onBlur 同样提交）。 */
  const commitScrub = () => {
    if (scrubTimerRef.current) {
      clearTimeout(scrubTimerRef.current)
      scrubTimerRef.current = null
    }
    const value = scrubRef.current
    if (value !== null) {
      player.seek(value)
      scrubRef.current = null
      setScrub(null)
    }
  }

  /**
   * 拖拽中的超时自动提交兜底：每次 onChange 刷新定时器，1 秒内无后续输入则自动提交。
   * 正常拖拽/点按会被 onPointerUp 先行提交；pointerup 丢失（WebView 偶发）时由它兜底，
   * 避免 scrub 残留把进度条永久钉死在半路。
   */
  const scheduleScrubCommit = () => {
    if (scrubTimerRef.current) clearTimeout(scrubTimerRef.current)
    scrubTimerRef.current = setTimeout(commitScrub, 1000)
  }

  const platform = currentSong?.platform ?? 'netease'
  const currentQuality = platform === 'netease' ? player.neteaseQuality : platform === 'qq' ? player.qqQuality : player.kugouQuality
  const qualityList = qualityOptions(platform)

  const playing = status === 'playing'
  const loading = status === 'loading'
  // 拖拽期间展示临时值，避免进度条回跳；松手后切回播放进度。
  const shownTime = scrub ?? currentTime
  const progressPercent = duration > 0 ? Math.min(100, (shownTime / duration) * 100) : 0

  const alreadyDownloaded = currentSong ? downloads.downloadedKeys.has(currentSong.key) : false
  const currentTask = currentSong ? downloads.tasks.find(task => task.song.key === currentSong.key && task.status === 'downloading') : undefined

  // 下载完成/失败的短暂过渡后，把防重入标记同步为「真正在下载」的任务集合，
  // 解除已完成歌曲的锁（已下载态交给 downloadedKeys 挡住）。
  useEffect(() => {
    downloadingKeyRef.current = new Set(downloads.tasks.filter(task => task.status === 'downloading').map(task => task.song.key))
  }, [downloads.tasks])

  /** 下载当前曲目：已完成/进行中/防重入窗口内均不重复触发。 */
  const handleDownload = () => {
    if (!currentSong || alreadyDownloaded || currentTask) return
    const key = currentSong.key
    // ref 同步检查：覆盖点击到 tasks state 更新之间的极小窗口（React 异步渲染）。
    if (downloadingKeyRef.current.has(key)) return
    downloadingKeyRef.current.add(key)
    void downloads.startDownload(currentSong, currentQuality)
  }

  return (
    <section className="now-playing-page">
      <div className="np-topbar">
        <button className="icon-btn" type="button" onClick={onClose} aria-label="收起播放页">
          <BackIcon />
        </button>
        <div className="np-topbar-right">
          <button
            type="button"
            className="np-download-toggle"
            onClick={handleDownload}
            disabled={!currentSong || alreadyDownloaded || Boolean(currentTask)}
            aria-label={alreadyDownloaded ? `${currentSong?.name} 已下载` : currentTask ? '正在下载' : `下载 ${currentSong?.name ?? '当前歌曲'}`}
            title={alreadyDownloaded ? '已下载' : '下载'}
          >
            {currentTask ? <LoaderIcon className="spin" /> : <DownloadIcon />}
          </button>
          <button
            type="button"
            className="np-quality-toggle"
            onClick={() => setQualityOpen(prev => !prev)}
            aria-expanded={qualityOpen}
            aria-label={`音质：${currentQuality}，点击选择`}
            title={`当前音质 ${currentQuality}`}
          >
            {currentQuality}
          </button>
        </div>
      </div>

      {/* 大封面：有图显图，无图用渐变占位 */}
      <div className="np-cover-wrap">
        <div className="np-cover">
          {currentSong?.cover ? <img src={currentSong.cover} alt="" /> : <div className="np-cover-fallback">CM</div>}
        </div>
        <h1 className="np-title">{currentSong ? currentSong.name : '暂无播放'}</h1>
        <p className="np-artist">{currentSong ? currentSong.artists.join(' / ') : '从发现页选择歌曲开始播放'}</p>
      </div>

      {/* 歌词区：可滚动，自动跟随高亮行 */}
      <div
        className="np-lyrics"
        onWheel={() => setManualUntil(Date.now() + 5000)}
        onTouchMove={() => setManualUntil(Date.now() + 5000)}
      >
        {source?.lyricError ? (
          <p className="no-lyrics">{source.lyricError}</p>
        ) : lines.length === 0 ? (
          <p className="no-lyrics">暂无歌词</p>
        ) : (
          lines.map((line, index) => (
            <p
              key={`${line.time}-${index}`}
              ref={(element) => { lineRefs.current[index] = element }}
              className={index === active ? 'active' : ''}
            >
              {line.text || '♪'}
              {translated[index]?.text && <small>{translated[index].text}</small>}
            </p>
          ))
        )}
      </div>

      {/* 播放加载 / 失败：清晰展示而非空白 */}
      {loading && currentSong && (
        <div className="np-loading" role="status">
          <LoaderIcon className="spin" />
          <span>{player.message || '正在获取播放地址'}</span>
        </div>
      )}
      {status === 'error' && currentSong && (
        <div className="np-error">
          <ErrorNotice message={player.message || '该歌曲暂时无法播放'} code={errorCode ?? undefined} onRetry={player.retry} onOpenSettings={onOpenSettings} />
        </div>
      )}

      {/* 进度条 + 时长：拖动中只更新本地临时值，松手/失焦才真正 seek */}
      <div className="np-progress">
        <input
          className="np-range"
          type="range"
          min={0}
          max={Math.max(duration, 1)}
          value={Math.min(shownTime, Math.max(duration, 1))}
          step={0.1}
          onChange={(event) => {
            const value = Number(event.target.value)
            scrubRef.current = value
            setScrub(value)
            scheduleScrubCommit()
          }}
          onPointerUp={commitScrub}
          onBlur={commitScrub}
          aria-label="播放进度"
          style={{ '--progress': `${progressPercent}%` } as React.CSSProperties}
          disabled={!currentSong}
        />
        <div className="np-times">
          <span>{time(shownTime)}</span>
          <span>{duration > 0 ? time(duration) : '--:--'}</span>
        </div>
      </div>

      {/* 控制区 */}
      <div className="np-controls">
        <button
          type="button"
          className="np-control np-repeat"
          onClick={advanceRepeat}
          aria-label={`循环模式：${REPEAT_LABEL[player.queue.repeatMode]}`}
          title={REPEAT_LABEL[player.queue.repeatMode]}
        >
          {RepeatGlyph[player.queue.repeatMode]}
        </button>
        <button type="button" className="np-control np-skip" onClick={player.previous} disabled={!currentSong} aria-label="上一首">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M6 5a1 1 0 0 1 2 0v5.6l9.2-5.7a1 1 0 0 1 1.5.86v12.9a1 1 0 0 1-1.5.86L8 13.4V19a1 1 0 0 1-2 0V5Z" />
          </svg>
        </button>
        <button
          type="button"
          className="np-play"
          onClick={player.toggle}
          disabled={!currentSong || loading}
          aria-label={playing ? '暂停' : '播放'}
        >
          {playing ? PauseIcon : PlayIcon}
        </button>
        <button type="button" className="np-control np-skip" onClick={player.next} disabled={!currentSong} aria-label="下一首">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M16 5a1 1 0 0 1 2 0v14a1 1 0 0 1-2 0v-5.6L6.8 19.1a1 1 0 0 1-1.5-.86V5.34a1 1 0 0 1 1.5-.86L16 12.4V5Z" />
          </svg>
        </button>
        <button
          type="button"
          className="np-control np-volume"
          onClick={() => setVolumeOpen(prev => !prev)}
          aria-expanded={volumeOpen}
          aria-label={muted ? '取消静音' : '静音'}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M11 5 6 9H2v6h4l5 4V5Z" />
            {muted || volume === 0 ? (
              <path d="m22 9-6 6m0-6 6 6" />
            ) : volume < 0.5 ? (
              <path d="M15.5 12a3.2 3.2 0 0 1-1.5 2.8" />
            ) : (
              <path d="M15.5 8.5a7 7 0 0 1 0 7M18.5 6a10 10 0 0 1 0 12" />
            )}
          </svg>
        </button>
      </div>

      {/* 音质 / 音量 弹层（带半透明遮罩，点遮罩关闭） */}
      {qualityOpen && (
        <>
          <div className="np-backdrop" onClick={() => setQualityOpen(false)} aria-hidden="true" />
          <div className="np-sheet np-quality" role="dialog" aria-modal="true" aria-label="选择音质">
            <PlayerSheetHeader title={`音质 · ${platform === 'netease' ? '网易云' : platform === 'qq' ? 'QQ 音乐' : '酷狗'}`} onClose={() => setQualityOpen(false)} />
            <div className="sheet-options">
              {qualityList.map(item => (
                <button key={item.value} type="button" className={`sheet-option${item.value === currentQuality ? ' active' : ''}`} onClick={() => { player.selectQuality(item.value); setQualityOpen(false) }}>
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      {volumeOpen && (
        <>
          <div className="np-backdrop" onClick={() => setVolumeOpen(false)} aria-hidden="true" />
          <div className="np-sheet np-volume" role="dialog" aria-modal="true" aria-label="调节音量">
            <PlayerSheetHeader title={`音量${muted ? '（已静音）' : ''}`} onClose={() => setVolumeOpen(false)} />
            <div className="sheet-volume-row">
              <button type="button" className="sheet-mini-btn" onClick={() => player.setMuted(!muted)} aria-label="静音切换">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M11 5 6 9H2v6h4l5 4V5Z" />
                  {muted || volume === 0 ? <path d="m22 9-6 6m0-6 6 6" /> : <path d="M15.5 8.5a7 7 0 0 1 0 7M18.5 6a10 10 0 0 1 0 12" />}
                </svg>
              </button>
              <input
                className="np-range"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                onChange={(event) => { player.setMuted(false); player.setVolume(Number(event.target.value)) }}
                aria-label="音量"
                style={{ '--progress': `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties}
              />
              <span className="sheet-volume-value">{Math.round((muted ? 0 : volume) * 100)}%</span>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

/** 弹层标题栏（音质/音量共用）。 */
function PlayerSheetHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="np-sheet-header">
      <span>{title}</span>
      <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
        <BackIcon />
      </button>
    </div>
  )
}
