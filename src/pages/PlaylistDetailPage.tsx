import { useEffect, useRef, useState } from 'react'
import { AppError, type PlaylistRef, type Song } from '@shared/contracts'
import { useAppState, type PlaylistKind } from '../app/AppState'
import { usePlayer } from '../player/usePlayer'
import { SongListItem } from '../components/SongListItem'
import { AddToPlaylistDialog, type AddToPlaylistResult } from '../components/AddToPlaylistDialog'
import { ErrorNotice } from '../components/ErrorNotice'
import { BackIcon, ListIcon, LoaderIcon, MusicIcon, PlayIcon, RefreshIcon } from '../components/icons'
import { useOverlayRegistry } from '../app/overlays'

interface PlaylistDetailPageProps {
  /** 歌单 ID（网易歌单为数字字符串；本地歌单为本地 UUID）。 */
  playlistId: string
  /** 歌单数据来源：本地自建歌单从 library 读，网易歌单走线上/缓存。 */
  kind: PlaylistKind
  onBack: () => void
  /** 错误引导：密钥无效（401）时跳设置页。 */
  onOpenSettings?: () => void
}

/**
 * PlaylistDetailPage —— 歌单详情页。
 * 封面 + 歌单名/创建者 + 曲目数 + 播放全部 [+ 导入到本地歌单]；曲目列表复用 SongListItem。
 * 两种数据来源（kind）：
 * - netease：数据经全局 AppState.playlistDetail 缓存（切 tab/切页后保留，切回秒开），
 *   加载逻辑（拉取+缓存）在此组件，结果写全局槽；仅当槽里没有该歌单数据时才发起加载。
 * - local：本地自建歌单，数据直读 state.library.playlists（本地已存曲目，无需异步加载），
 *   不写全局 playlistDetail 槽；隐藏「导入到本地」「刷新」等网易云特有操作。
 * 导入弹层 / 导入结果 toast 是临时交互状态，保留组件本地（切页后本就该关闭）。
 */
export function PlaylistDetailPage({ playlistId, kind, onBack, onOpenSettings }: PlaylistDetailPageProps) {
  const { state, dispatch } = useAppState()
  const player = usePlayer()
  const overlays = useOverlayRegistry()
  const detail = state.playlistDetail
  const favoriteKeys = new Set(state.library?.favorites.map(song => song.key) ?? [])
  /** 本地歌单详情：kind=local 时直接从 library 读（秒出，无加载态）。 */
  const localPlaylist = kind === 'local' ? state.library?.playlists.find(item => item.id === playlistId) ?? null : null
  /** 当前展示的歌单（本地模式取 LocalPlaylist，网易模式取全局缓存）。 */
  const playlist: PlaylistRef | null = kind === 'local' ? null : detail.playlist
  const loading = kind === 'local' ? false : detail.loading
  const error = kind === 'local' ? '' : detail.error
  const errorCode = kind === 'local' ? undefined : detail.errorCode
  /** 当前打开的「导入到本地歌单」弹层（对应已加载的网易歌单，本地歌单无此操作）。 */
  const [importingTo, setImportingTo] = useState<PlaylistRef | null>(null)
  /** 当前打开的「加入歌单」弹层歌曲（单曲，弹层出自曲目行的加号按钮）。 */
  const [songAdding, setSongAdding] = useState<Song | null>(null)
  /** 导入结果提示（成功后短暂展示，自动消失 + 点击可关）。 */
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

  // 浮层注册进全局 overlay 注册表：返回键先关弹层。cleanup 自动注销。
  useEffect(() => importingTo ? overlays.register({ id: 'playlist-import', close: () => setImportingTo(null) }) : undefined, [importingTo, overlays])
  useEffect(() => songAdding ? overlays.register({ id: 'song-add', close: () => setSongAdding(null) }) : undefined, [songAdding, overlays])

  const dismissNotice = () => {
    if (noticeTid.current) clearTimeout(noticeTid.current)
    noticeTid.current = null
    setNotice('')
  }

  /** 单曲收藏/取消收藏（网易歌单曲目行）→ 写库 + 广播快照。 */
  const toggleFavorite = async (song: Song) => {
    try {
      const library = await window.chksz.library.toggleFavorite(song)
      dispatch({ type: 'libraryChanged', library })
    } catch {
      // 收藏写失败静默忽略，列表仍可正常浏览播放。
    }
  }

  /** 单曲加入本地歌单：先判断已存在以准确提示，addSong 去重写入。 */
  const addSongToLocal = async (targetId: string): Promise<AddToPlaylistResult> => {
    if (!songAdding) return { added: 0, skipped: 0 }
    const before = (state.library?.playlists.find(item => item.id === targetId)?.songs ?? []).some(song => song.key === songAdding.key)
    const library = await window.chksz.library.addSong(targetId, songAdding)
    dispatch({ type: 'libraryChanged', library })
    const target = library.playlists.find(item => item.id === targetId)
    showNotice(before ? `「${songAdding.name}」已在「${target?.name ?? '歌单'}」中` : `已添加到「${target?.name ?? '歌单'}」`)
    setSongAdding(null)
    return before ? { added: 0, skipped: 1 } : { added: 1, skipped: 0 }
  }

  /** 新建本地歌单并单曲塞入。 */
  const createAndAddSong = async (name: string): Promise<AddToPlaylistResult> => {
    if (!songAdding) return { added: 0, skipped: 0 }
    const created = await window.chksz.library.createPlaylist(name)
    const createdPlaylist = created.playlists[0]
    if (!createdPlaylist) return { added: 0, skipped: 0 }
    const library = await window.chksz.library.addSong(createdPlaylist.id, songAdding)
    dispatch({ type: 'libraryChanged', library })
    showNotice(`已添加到「${createdPlaylist.name}」`)
    setSongAdding(null)
    return { added: 1, skipped: 0 }
  }

  const load = async (forceRefresh = false) => {
    if (kind === 'local') return
    const requestId = crypto.randomUUID()
    dispatch({ type: 'playlistDetailStarted', playlistId, kind, requestId })
    try {
      const ref = await window.chksz.music.neteasePlaylistById(playlistId, forceRefresh)
      dispatch({ type: 'playlistDetailSucceeded', playlistId, kind, requestId, playlist: ref })
    } catch (loadError) {
      dispatch({
        type: 'playlistDetailFailed',
        playlistId,
        kind,
        requestId,
        message: loadError instanceof Error ? loadError.message : '歌单读取失败',
        errorCode: loadError instanceof AppError ? loadError.code : undefined,
      })
    }
  }

  useEffect(() => {
    // 本地歌单直读 library 即可（秒出，无加载态）；网易歌单仅当槽里没有该歌单数据时才加载
    // （切回已有结果的歌单时秒开，不重复拉取）。
    if (kind !== 'local' && !playlist && !loading) void load()
    // 依赖 playlistId/kind：切换歌单时（openPlaylist 已重置槽）重新加载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlistId, kind])

  /** 加入现有本地歌单：先算「将新增/将跳过」，写库后再展示实际结果。 */
  const addToLocal = async (targetId: string): Promise<AddToPlaylistResult> => {
    if (!importingTo) return { added: 0, skipped: 0 }
    const beforeKeys = new Set((state.library?.playlists.find(item => item.id === targetId)?.songs ?? []).map(song => song.key))
    const result = await window.chksz.library.addSongs(targetId, importingTo.songs)
    dispatch({ type: 'libraryChanged', library: result })
    const target = result.playlists.find(item => item.id === targetId)
    const added = (target?.songs ?? []).filter(song => !beforeKeys.has(song.key)).length
    const skipped = importingTo.songs.length - added
    showNotice(`已添加 ${added} 首到「${target?.name ?? '歌单'}」${skipped > 0 ? `（跳过 ${skipped} 首重复）` : ''}`)
    setImportingTo(null)
    return { added, skipped }
  }

  /** 新建本地歌单并整单塞入。 */
  const createAndAdd = async (name: string): Promise<AddToPlaylistResult> => {
    if (!importingTo) return { added: 0, skipped: 0 }
    const created = await window.chksz.library.createPlaylist(name)
    dispatch({ type: 'libraryChanged', library: created })
    // createPlaylist 把新歌单 unshift 到队首；用首项定位（名称可能被截断到 60 字，不能按名匹配）。
    const createdPlaylist = created.playlists[0]
    if (!createdPlaylist) return { added: 0, skipped: 0 }
    const result = await window.chksz.library.addSongs(createdPlaylist.id, importingTo.songs)
    dispatch({ type: 'libraryChanged', library: result })
    showNotice(`已添加 ${result.playlists.find(item => item.id === createdPlaylist.id)?.songs.length ?? 0} 首到「${name}」`)
    setImportingTo(null)
    return { added: result.playlists.find(item => item.id === createdPlaylist.id)?.songs.length ?? 0, skipped: 0 }
  }

  /** 从本地歌单移除单曲（仅本地歌单详情页；删除不二次确认——与桌面版一致，可恢复性由收藏兜底）。 */
  const removeSong = async (song: Song) => {
    if (kind !== 'local') return
    try {
      const result = await window.chksz.library.removeSong(playlistId, song.key)
      dispatch({ type: 'libraryChanged', library: result })
    } catch {
      showNotice('移除歌曲失败，请重试')
    }
  }

  /** 统一展示视图：两种来源都投影成 { name, cover, subtitle, songs }，渲染区不再分支。
 *  本地歌单无自有封面，cover 固定为空 → hero 走音符占位（不用首曲封面）。 */
  const view =
    kind === 'local'
      ? localPlaylist
        ? {
            name: localPlaylist.name,
            cover: '',
            subtitle: `${localPlaylist.songs.length} 首歌曲`,
            songs: localPlaylist.songs,
          }
        : null
      : playlist
        ? {
            name: playlist.name || '未命名歌单',
            cover: playlist.cover,
            subtitle: `${playlist.creator || '网易用户'} · ${playlist.songCount} 首歌曲`,
            songs: playlist.songs,
          }
        : null

  return (
    <section className="playlist-detail-page">
      <div className="detail-topbar">
        <button className="icon-btn" type="button" onClick={onBack} aria-label="返回">
          <BackIcon />
        </button>
        {kind !== 'local' && (
          <button className="icon-btn" type="button" onClick={() => void load(true)} disabled={loading} aria-label="刷新歌单">
            <RefreshIcon className={loading ? 'spin' : undefined} />
          </button>
        )}
      </div>
      {error && !view && <ErrorNotice message={error} code={errorCode} onRetry={() => void load()} onOpenSettings={onOpenSettings} />}
      {!error && view === null && !loading && <div className="list-status">歌单不存在或读取失败{playlistId ? '，请检查歌单 ID' : ''}</div>}
      {loading && view === null && <div className="list-status"><LoaderIcon className="spin" /><span>正在读取歌单，大歌单可能需要几秒…</span></div>}
      {!loading && error && view && <ErrorNotice message={error} code={errorCode} onRetry={() => void load(true)} onOpenSettings={onOpenSettings} />}
      {view && (
        <>
          <div className="playlist-hero">
            <div className={`hero-cover${kind === 'local' ? ' local' : ''}`}>
              {view.cover ? (
                <img src={view.cover} alt="" />
              ) : kind === 'local' ? (
                <span className="hero-notes" aria-hidden="true">
                  <span className="note-disc" />
                  <span className="note-ring" />
                  <span className="note-ring-inner" />
                  <MusicIcon className="note-main" />
                  <span className="note-spindle" />
                  {/* 唱片装饰：左下角一个边缘音符，其余音符/圆点/短线在盘面内随机美观分布 */}
                  <MusicIcon className="note-float note-corner" />
                  <MusicIcon className="note-float note-in-a" />
                  <MusicIcon className="note-float note-in-b" />
                  <span className="deco-dot deco-dot-a" />
                  <span className="deco-dot deco-dot-b" />
                  <span className="deco-stroke deco-stroke-a" />
                  <span className="deco-stroke deco-stroke-b" />
                </span>
              ) : (
                <span className="cover-fallback netease">云</span>
              )}
            </div>
            <div className="hero-meta">
              <h1>{view.name}</h1>
              <p>{view.subtitle}</p>
              <div className="hero-actions">
                <button className="primary-button" type="button" onClick={() => player.playSongs(view.songs, 0)} disabled={!view.songs.length}>
                  {PlayIcon}
                  播放全部
                </button>
                {kind !== 'local' && playlist && (
                  <button className="ghost-button" type="button" onClick={() => setImportingTo(playlist)} disabled={!playlist.songs.length}>
                    <ListIcon />
                    导入到本地
                  </button>
                )}
              </div>
            </div>
          </div>
          {view.songs.length === 0 ? (
            <div className="list-status">{kind === 'local' ? '空歌单，去搜索页添加歌曲' : '歌单里还没有歌曲（可能是官方清理或接口限制）'}</div>
          ) : (
            <ul className="song-list">
              {view.songs.map((song, index) => (
                <SongListItem
                  key={song.key}
                  song={song}
                  index={index}
                  active={player.currentSong?.key === song.key}
                  playing={player.status === 'playing'}
                  favorite={favoriteKeys.has(song.key)}
                  onPlay={() => player.playSongs(view.songs, index)}
                  onFavorite={(item) => void toggleFavorite(item)}
                  onAddToPlaylist={setSongAdding}
                  onRemove={kind === 'local' ? (item) => void removeSong(item) : undefined}
                />
              ))}
            </ul>
          )}
        </>
      )}
      {importingTo && (
        <AddToPlaylistDialog
          songs={importingTo.songs}
          note={`${importingTo.name || importingTo.sourceId} · ${importingTo.songCount} 首`}
          playlists={state.library?.playlists ?? []}
          onAdd={addToLocal}
          onCreate={createAndAdd}
          onClose={() => setImportingTo(null)}
        />
      )}
      {songAdding && (
        <AddToPlaylistDialog
          songs={[songAdding]}
          note={songAdding.name}
          playlists={state.library?.playlists ?? []}
          onAdd={addSongToLocal}
          onCreate={createAndAddSong}
          onClose={() => setSongAdding(null)}
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
