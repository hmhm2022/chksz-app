import { useState } from 'react'
import { useAppState } from '../app/AppState'
import { usePlayer } from '../player/usePlayer'
import { SongListItem } from '../components/SongListItem'
import { BackIcon, LoaderIcon } from '../components/icons'

interface HistoryPageProps {
  onBack: () => void
}

/**
 * HistoryPage —— 播放历史页（独立二级页面）。
 * 带返回顶栏（清空按钮在右侧），主体为歌曲列表，空态复用 list-status。
 */
export function HistoryPage({ onBack }: HistoryPageProps) {
  const { state, dispatch } = useAppState()
  const player = usePlayer()
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState('')
  const history = state.library?.history ?? []

  const clearHistory = async () => {
    setClearing(true)
    setError('')
    try {
      const library = await window.chksz.library.clearHistory()
      dispatch({ type: 'libraryChanged', library })
    } catch {
      setError('清空历史失败，请重试')
    } finally {
      setClearing(false)
    }
  }

  return (
    <section className="downloads-page">
      <header className="page-topbar">
        <button className="icon-btn" type="button" onClick={onBack} aria-label="返回">
          <BackIcon />
        </button>
        <h1 className="page-topbar-title">播放历史</h1>
        {history.length > 0 ? (
          <button type="button" className="ghost-button small" onClick={() => void clearHistory()} disabled={clearing}>
            {clearing ? <LoaderIcon className="spin" /> : <span>清空</span>}
          </button>
        ) : (
          <span className="page-topbar-spacer" />
        )}
      </header>

      {error && <p className="inline-error" style={{ padding: 'var(--space-sm) var(--space-md)' }}>{error}</p>}

      {history.length === 0 ? (
        <div className="list-status">还没有播放记录，去发现页听一首歌就有了</div>
      ) : (
        <div className="downloads-body">
          <ul className="song-list">
            {history.map(song => (
              <SongListItem
                key={song.key}
                song={song}
                active={player.currentSong?.key === song.key}
                playing={player.status === 'playing'}
                onPlay={player.playSong}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
