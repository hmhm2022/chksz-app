import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AppError, type MusicPlatform, type Song } from '@shared/contracts'
import { useAppState } from '../app/AppState'
import { usePlayer } from '../player/usePlayer'
import { SongListItem } from '../components/SongListItem'
import { AddToPlaylistDialog, type AddToPlaylistResult } from '../components/AddToPlaylistDialog'
import { ErrorNotice } from '../components/ErrorNotice'
import { BackIcon, LoaderIcon, SearchIcon } from '../components/icons'
import { useOverlayRegistry } from '../app/overlays'

const PLATFORMS: Array<{ id: MusicPlatform; label: string }> = [
  { id: 'netease', label: '网易云' },
  { id: 'qq', label: 'QQ' },
  { id: 'kugou', label: '酷狗' },
]

interface SearchPageProps {
  onBack: () => void
  /** 错误引导：密钥无效 / 网易免费搜索源失效时跳设置页。 */
  onOpenSettings?: () => void
}

/**
 * SearchPage —— 搜索页。
 * 顶部真输入框 + 平台 chips，下方结果列表（SongListItem）。
 * 搜索状态（词/结果/平台槽）全部在全局 AppState.search 里（每平台一个槽，切页不丢失），
 * 本组件只是「读槽 + 派发 action」的薄壳：
 * - 输入框受控值 = 当前平台槽 query（切走再切回原样恢复）
 * - 搜索/结果/错误状态 = 当前平台槽 status/songs/message/errorCode
 * - 竞态防护双轨：同一页内多次搜索用组件本地 requestId（桌面版同款，只认最新）；
 *   跨平台切换用全局 searchSeq（searchPlatformChanged 自增作废在途，防旧响应写错槽）。
 * 行为与桌面版一致：切平台不互相清空、收藏后列表即时反映。
 */
export function SearchPage({ onBack, onOpenSettings }: SearchPageProps) {
  const { state, dispatch } = useAppState()
  const player = usePlayer()
  const overlays = useOverlayRegistry()
  const favoriteKeys = new Set(state.library?.favorites.map(song => song.key) ?? [])
  /** 当前打开的「加入歌单」弹层歌曲（单曲）。 */
  const [addingTo, setAddingTo] = useState<Song | null>(null)
  /** 加入结果提示。 */
  const [notice, setNotice] = useState('')
  const noticeTid = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** 展示 toast：清除旧定时器，4 秒后自动消失。 */
  const showNotice = (text: string) => {
    setNotice(text)
    if (noticeTid.current) clearTimeout(noticeTid.current)
    noticeTid.current = setTimeout(() => setNotice(''), 4000)
  }

  /** 卸载时清理定时器，避免组件卸载后 setNotice（React 警告）。 */
  useEffect(() => () => {
    if (noticeTid.current) clearTimeout(noticeTid.current)
  }, [])

  // 加入歌单弹层注册进全局 overlay 注册表：返回键先关弹层。cleanup 自动注销。
  useEffect(() => addingTo ? overlays.register({ id: 'song-add', close: () => setAddingTo(null) }) : undefined, [addingTo, overlays])

  // 搜索槽 = 当前展示平台；进入搜索页后平台由 chips 切换（不再随 defaultPlatform 变）。
  const searchPlatform = state.searchPlatform
  const search = state.search[searchPlatform]

  // 竞态防护双轨：
  //  - requestIdRef（组件本地，桌面版同款）：同一搜索页内多次搜索只认最新，防旧响应覆盖新结果。
  //    页面卸载重挂归零无妨——旧闭包因组件已卸载不再渲染。
  //  - 全局 searchSeq：由 searchPlatformChanged 自增，作废跨平台的在途请求（避免旧响应写错槽）。
  const requestIdRef = useRef(0)

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    const keyword = search.query.trim()
    if (!keyword) return
    const id = ++requestIdRef.current
    const requestPlatform = searchPlatform
    const requestSeq = state.searchSeq
    dispatch({ type: 'searchStarted', query: keyword })
    try {
      const result = await window.chksz.music.search(requestPlatform, keyword, 20)
      if (id !== requestIdRef.current) return
      dispatch({ type: 'searchSucceeded', platform: requestPlatform, seq: requestSeq, songs: result })
    } catch (error) {
      if (id !== requestIdRef.current) return
      dispatch({
        type: 'searchFailed',
        platform: requestPlatform,
        seq: requestSeq,
        message: error instanceof Error ? error.message : '搜索失败，请重试',
        errorCode: error instanceof AppError ? error.code : undefined,
      })
    }
  }

  const changePlatform = (next: MusicPlatform) => {
    if (next === searchPlatform) return
    dispatch({ type: 'searchPlatformChanged', platform: next })
  }

  const dismissNotice = () => {
    if (noticeTid.current) clearTimeout(noticeTid.current)
    noticeTid.current = null
    setNotice('')
  }

  const toggleFavorite = async (song: Song) => {
    try {
      const library = await window.chksz.library.toggleFavorite(song)
      // 同步刷新该平台搜索结果槽：收藏操作即时反映到列表（不需切页），并广播新库快照。
      dispatch({
        type: 'searchCompleted',
        platform: song.platform,
        songs: state.search[song.platform].songs,
        library,
      })
    } catch {
      // 收藏写失败静默忽略（列表仍可正常浏览与播放）。
    }
  }

  /** 加入现有本地歌单（单曲）：先判断是否已存在，addSong 去重后提示实际结果。 */
  const addToLocal = async (targetId: string): Promise<AddToPlaylistResult> => {
    if (!addingTo) return { added: 0, skipped: 0 }
    const before = (state.library?.playlists.find(item => item.id === targetId)?.songs ?? []).some(song => song.key === addingTo.key)
    const library = await window.chksz.library.addSong(targetId, addingTo)
    dispatch({ type: 'libraryChanged', library })
    const target = library.playlists.find(item => item.id === targetId)
    showNotice(before ? `「${addingTo.name}」已在「${target?.name ?? '歌单'}」中` : `已添加到「${target?.name ?? '歌单'}」`)
    setAddingTo(null)
    return before ? { added: 0, skipped: 1 } : { added: 1, skipped: 0 }
  }

  /** 新建本地歌单并单曲塞入。 */
  const createAndAdd = async (name: string): Promise<AddToPlaylistResult> => {
    if (!addingTo) return { added: 0, skipped: 0 }
    const created = await window.chksz.library.createPlaylist(name)
    const createdPlaylist = created.playlists[0]
    if (!createdPlaylist) return { added: 0, skipped: 0 }
    const library = await window.chksz.library.addSong(createdPlaylist.id, addingTo)
    dispatch({ type: 'libraryChanged', library })
    showNotice(`已添加到「${createdPlaylist.name}」`)
    setAddingTo(null)
    return { added: 1, skipped: 0 }
  }

  return (
    <section className="search-page">
      <div className="page-topbar">
        <button className="icon-btn" type="button" onClick={onBack} aria-label="返回">
          <BackIcon />
        </button>
        <form className="search-input" onSubmit={submit} role="search">
          <SearchIcon />
          <input
            aria-label="搜索歌曲"
            value={search.query}
            onChange={(event) => dispatch({ type: 'searchQueryChanged', query: event.target.value })}
            placeholder="搜索歌曲、歌手"
            autoFocus
          />
          <button type="submit" disabled={!search.query.trim() || search.status === 'loading'} aria-label="搜索">
            {search.status === 'loading' ? <LoaderIcon className="spin" /> : <span>搜索</span>}
          </button>
        </form>
      </div>
      <div className="platform-chips" role="group" aria-label="搜索平台">
        {PLATFORMS.map(item => (
          <button key={item.id} type="button" className={`platform-chip${searchPlatform === item.id ? ' active' : ''}`} onClick={() => changePlatform(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      <div className="search-body">
        {search.status === 'idle' && <div className="list-status">输入关键词，搜索 {PLATFORMS.find(item => item.id === searchPlatform)?.label} 的歌曲；QQ / 酷狗优先走免费接口，网易云可在设置中切换免费源</div>}
        {search.status === 'loading' && <div className="list-status"><LoaderIcon className="spin" /><span>{search.message || '正在搜索…'}</span></div>}
        {search.status === 'error' && (
          <ErrorNotice
            message={search.message}
            code={search.errorCode}
            onOpenSettings={onOpenSettings}
            onRetry={() => void submit()}
          />
        )}
        {search.status === 'success' && search.songs.length === 0 && <div className="list-status">{search.message}</div>}
        {search.status === 'success' && search.songs.length > 0 && (
          <>
            <div className="result-count">共 {search.songs.length} 首，点击左侧播放</div>
            <ul className="song-list">
              {search.songs.map(song => (
                <SongListItem
                  key={song.key}
                  song={song}
                  active={player.currentSong?.key === song.key}
                  playing={player.status === 'playing'}
                  favorite={favoriteKeys.has(song.key)}
                  onPlay={player.playSong}
                  onFavorite={(item) => void toggleFavorite(item)}
                  onAddToPlaylist={setAddingTo}
                />
              ))}
            </ul>
          </>
        )}
      </div>
      {addingTo && (
        <AddToPlaylistDialog
          songs={[addingTo]}
          note={addingTo.name}
          playlists={state.library?.playlists ?? []}
          onAdd={addToLocal}
          onCreate={createAndAdd}
          onClose={() => setAddingTo(null)}
        />
      )}
      {notice && (
        <div className="toast" role="status" onClick={dismissNotice}>
          {notice}
        </div>
      )}
    </section>
  )
}
