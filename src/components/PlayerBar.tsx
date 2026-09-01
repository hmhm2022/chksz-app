import type { MouseEvent } from 'react'
import { PauseIcon, PlayIcon } from './icons'
import { usePlayer } from '../player/usePlayer'

/** mm:ss 格式化进度（与桌面版一致）。 */
const time = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`

const CoverPlaceholder = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </svg>
)

/**
 * PlayerBar —— 底部迷你播放条。
 * 接 usePlayer：左侧封面（有图显图，无图显占位），中部歌曲名/歌手 + 播放进度，右侧播放/暂停。
 * 无歌时保持“暂无播放”（按钮禁用）。点击封面/歌名区域展开全屏播放页（onExpand）。
 * 播放失败时整段可点重试；若为密钥无效（401），额外提供「去设置换密钥」跳转（onOpenSettings）。
 */
export function PlayerBar({ onExpand, onOpenSettings }: { onExpand?: () => void; onOpenSettings?: () => void }) {
  const player = usePlayer()
  const { currentSong, status, message, errorCode, currentTime, duration } = player
  const playing = status === 'playing'
  const loading = status === 'loading'
  const percent = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0
  /** 点击进度条跳转：按点击位置相对宽度换算秒数 seek。 */
  const handleSeek = (event: MouseEvent<HTMLButtonElement>) => {
    if (!currentSong || duration <= 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / rect.width
    player.seek(ratio * duration)
  }
  return (
    <footer className="player-bar" aria-label="迷你播放条">
      {message && status === 'loading' && <div className="player-message" role="status">{message}</div>}
      {status === 'error' ? (
        // 播放失败：整段可点重试（与展开区域同槽位），保留播放/暂停按钮；401 时补「去设置换密钥」。
        <div className="player-error">
          <button type="button" className="player-retry" onClick={player.retry} aria-label={`重试播放${currentSong ? ` ${currentSong.name}` : ''}`}>
            <span className="player-retry-text">{message || '该歌曲暂时无法播放'}</span>
            <span className="player-retry-action">点击重试</span>
          </button>
          {errorCode === 'UNAUTHORIZED' && onOpenSettings && (
            <button type="button" className="player-settings-jump" onClick={onOpenSettings}>
              去设置换密钥
            </button>
          )}
        </div>
      ) : (
        <button
          className="player-expand"
          type="button"
          onClick={onExpand}
          disabled={!currentSong || !onExpand}
          aria-label="展开播放页"
        >
          <div className="cover">
            {currentSong?.cover ? <img src={currentSong.cover} alt="" /> : CoverPlaceholder}
          </div>
          <div className="meta">
            <strong>{currentSong?.name || '暂无播放'}</strong>
            <span>{currentSong ? currentSong.artists.join(' / ') : '从发现页选择歌曲开始播放'}</span>
          </div>
          {currentSong && (
            <div className="progress">
              <span className="time-current">{time(currentTime)}</span>
              <span className="time-duration">{duration > 0 ? time(duration) : '--:--'}</span>
            </div>
          )}
        </button>
      )}
      {currentSong && status !== 'error' && (
        <button
          type="button"
          className="player-progress"
          onClick={handleSeek}
          disabled={duration <= 0}
          aria-label="播放进度，点击跳转"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(currentTime)}
        >
          <span className="player-progress-fill" style={{ width: `${percent}%` }} />
        </button>
      )}
      <button
        className="play-btn"
        type="button"
        disabled={!currentSong || loading}
        onClick={player.toggle}
        aria-label={playing ? '暂停' : '播放'}
        title={playing ? '暂停' : '播放'}
      >
        {playing ? PauseIcon : PlayIcon}
      </button>
    </footer>
  )
}
