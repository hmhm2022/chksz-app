import { useState } from 'react'
import { useAppState } from '../app/AppState'
import { usePlayer } from '../player/usePlayer'
import { SongListItem } from '../components/SongListItem'
import { HeartIcon } from '../components/icons'

/**
 * FavoritesPage —— 收藏 tab。
 * 收藏歌曲列表（state.library.favorites），点击播放，点心形取消收藏（乐观移除）。
 */
export function FavoritesPage() {
  const { state, dispatch } = useAppState()
  const player = usePlayer()
  const [error, setError] = useState('')
  const songs = state.library?.favorites ?? []

  const toggleFavorite = async (songKey: string) => {
    const song = songs.find(item => item.key === songKey)
    if (!song) return
    setError('')
    try {
      const library = await window.chksz.library.toggleFavorite(song)
      dispatch({ type: 'libraryChanged', library })
    } catch {
      setError('取消收藏失败，请重试')
    }
  }

  if (songs.length === 0) {
    return (
      <section className="list-page">
        <header className="page-heading">
          <h1>收藏</h1>
          <p>喜欢的歌曲会保存在这里</p>
        </header>
        <div className="list-status">
          <HeartIcon />
          <span>还没有收藏歌曲，去发现页搜索并点红心收藏吧</span>
        </div>
      </section>
    )
  }

  return (
    <section className="list-page">
      <header className="page-heading">
        <h1>收藏</h1>
        <span>{songs.length} 首</span>
      </header>
      {error && <p className="inline-error">{error}</p>}
      <ul className="song-list">
        {songs.map(song => (
          <SongListItem
            key={song.key}
            song={song}
            active={player.currentSong?.key === song.key}
            playing={player.status === 'playing'}
            favorite
            onPlay={player.playSong}
            onFavorite={(item) => void toggleFavorite(item.key)}
          />
        ))}
      </ul>
    </section>
  )
}
