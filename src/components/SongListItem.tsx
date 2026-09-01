import type { Song } from '@shared/contracts'
import { ListPlusIcon, PauseIcon, PlayIcon, TrashIcon } from './icons'
import { usePlayer } from '../player/usePlayer'

const platformLabel: Record<Song['platform'], string> = { netease: '网易', qq: 'QQ', kugou: '酷狗' }

/** mm:ss 格式化时长（与 PlayerBar 一致）。 */
const time = (value: number | null) =>
  value === null ? '--:--' : `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`

/** 无封面时的平台字占位（"网易云/QQ/酷狗"取字）。 */
const COVER_FALLBACK: Record<Song['platform'], string> = { netease: '云', qq: 'Q', kugou: 'K' }

interface SongListItemProps {
  song: Song
  /** 列表序号（歌单页显示，搜索结果不显示）。 */
  index?: number
  /** 当前正在播放的歌曲（高亮 + 显示暂停图标）。 */
  active?: boolean
  playing?: boolean
  /** 是否已收藏。传入时显示收藏按钮。 */
  favorite?: boolean
  onPlay?: (song: Song) => void
  /** 单曲收藏/取消收藏。 */
  onFavorite?: (song: Song) => void
  /** 加入本地歌单（弹出歌单选择）。传入时显示加入按钮。 */
  onAddToPlaylist?: (song: Song) => void
  /** 从当前歌单移除。传入时显示删除按钮。 */
  onRemove?: (song: Song) => void
}

/**
 * SongListItem —— 移动版共享歌曲行。
 * 布局：封面缩略图 + 曲名/歌手 + 右侧操作按钮（平台/时长在有操作按钮时隐藏以腾出空间）。
 * 点击行主体播放；操作按钮独立点击（stopPropagation）。
 */
export function SongListItem({ song, index, active = false, playing = false, favorite, onPlay, onFavorite, onAddToPlaylist, onRemove }: SongListItemProps) {
  const player = usePlayer()
  const handlePlay = () => {
    // 正在播放的这首歌再点一次 = 暂停/继续（沿用 PlayerBar 的语义），而不是重新入队重头播。
    if (active) {
      player.toggle()
      return
    }
    onPlay?.(song)
  }
  const actions = Boolean(onFavorite || onAddToPlaylist || onRemove)
  return (
    <li className={`song-list-item${active ? ' active' : ''}`}>
      {index !== undefined && <span className="song-index">{String(index + 1).padStart(2, '0')}</span>}
      {/* 封面 + 歌名合并为同一个播放按钮（读屏只宣告一次；视觉样式不变）。 */}
      <button className="song-main" type="button" onClick={handlePlay} aria-label={`播放 ${song.name}，${song.artists.join(' / ') || '未知歌手'}`}>
        <span className="song-cover">
          {song.cover ? <img src={song.cover} alt="" loading="lazy" /> : <span className={`cover-fallback ${song.platform}`}>{COVER_FALLBACK[song.platform]}</span>}
          {active && <span className="cover-playing">{playing ? PauseIcon : PlayIcon}</span>}
        </span>
        <span className="song-meta">
          <strong className="song-name">{song.name}</strong>
          <span className="song-artist">{song.artists.join(' / ') || '未知歌手'}</span>
        </span>
      </button>
      {actions ? (
        <span className="song-actions">
          {onFavorite && (
            <button
              className={`song-action${favorite ? ' active' : ''}`}
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onFavorite(song)
              }}
              aria-label={favorite ? `取消收藏 ${song.name}` : `收藏 ${song.name}`}
            >
              <svg viewBox="0 0 24 24" fill={favorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M19.5 12.6 12 20l-7.5-7.4A5 5 0 1 1 12 6.3a5 5 0 1 1 7.5 6.3Z" />
              </svg>
            </button>
          )}
          {onAddToPlaylist && (
            <button
              className="song-action"
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onAddToPlaylist(song)
              }}
              aria-label={`加入歌单 ${song.name}`}
            >
              <ListPlusIcon />
            </button>
          )}
          {onRemove && (
            <button
              className="song-action"
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onRemove(song)
              }}
              aria-label={`从歌单移除 ${song.name}`}
            >
              <TrashIcon />
            </button>
          )}
        </span>
      ) : (
        <span className="song-side" aria-hidden="true">
          <span className="song-platform">{platformLabel[song.platform]}</span>
          <span className="song-duration">{time(song.duration)}</span>
        </span>
      )}
    </li>
  )
}
