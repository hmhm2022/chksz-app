import { useRef, useState, type FormEvent } from 'react'
import type { LocalPlaylist, NeteasePlaylistSummary } from '@shared/contracts'
import { useAppState } from '../app/AppState'
import { usePlayer } from '../player/usePlayer'
import { ErrorNotice } from '../components/ErrorNotice'
import { ListIcon, LoaderIcon, PlayIcon, SearchIcon } from '../components/icons'
import { extractNeteasePlaylistId } from '../utils/neteaseImport'

const PLAYLIST_PAGE = 12

interface PlaylistsPageProps {
  /** 打开歌单详情：id + 数据来源（本地自建 / 网易线上），缺省网易。 */
  openPlaylistDetail: (playlistId: string, kind?: 'netease' | 'local') => void
}

/** 页内标签：本地歌单 / 网易云歌单。 */
type PageTab = 'mine' | 'netease'

/**
 * PlaylistsPage —— 歌单 tab。
 * 页内 2 标签：我的歌单（新建/列表/详情/删除）+ 网易云歌单（合并的搜索/导入输入框 + 结果 + 最近导入）。
 * 两个标签常驻渲染、CSS 显隐，切换后保留各自输入与结果状态。
 */
export function PlaylistsPage({ openPlaylistDetail }: PlaylistsPageProps) {
  const { state, dispatch } = useAppState()
  const player = usePlayer()
  const library = state.library
  const playlists = library?.playlists ?? []
  const [pageTab, setPageTab] = useState<PageTab>('netease')
  const [createName, setCreateName] = useState('')
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<LocalPlaylist | null>(null)

  // —— 搜索发现（网易云歌单）——
  const [discoverQuery, setDiscoverQuery] = useState('')
  const [discover, setDiscover] = useState<NeteasePlaylistSummary[] | null>(null)
  const [discoverTotal, setDiscoverTotal] = useState<number | null>(null)
  const [discoverMessage, setDiscoverMessage] = useState('')
  const [discoverLoading, setDiscoverLoading] = useState(false)
  const discoverSeq = useRef(0)

  const create = async (event: FormEvent) => {
    event.preventDefault()
    if (!createName.trim()) return
    setMessage('')
    try {
      const librarySnapshot = await window.chksz.library.createPlaylist(createName)
      dispatch({ type: 'libraryChanged', library: librarySnapshot })
      setCreateName('')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '新建歌单失败')
    }
  }

  /** 导入网易歌单并打开详情：保存快照 → 刷新 library → 跳详情。 */
  const importAndOpen = async (id: string) => {
    if (importing) return
    setImporting(true)
    setMessage('')
    try {
      await window.chksz.music.importNeteasePlaylist(id)
      const fresh = await window.chksz.library.get()
      dispatch({ type: 'libraryChanged', library: fresh })
      // 成功后跳详情页（组件卸载）；失败则留在本页显示 message。
      openPlaylistDetail(id)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '网易歌单导入失败')
    } finally {
      setImporting(false)
    }
  }

  /** 合并的搜索/导入提交：粘贴 ID / 分享链接 → 导入并打开详情；普通关键词走歌单搜索。 */
  const submitDiscover = async (event?: FormEvent) => {
    event?.preventDefault()
    const keyword = discoverQuery.trim()
    if (!keyword || discoverLoading) return
    const seq = ++discoverSeq.current
    const id = extractNeteasePlaylistId(keyword)
    if (id) {
      // 失效在途的搜索请求（导入期间若有关键词搜索在途，应作废）。
      ++discoverSeq.current
      await importAndOpen(id)
      return
    }
    setDiscoverLoading(true)
    setDiscoverMessage('')
    try {
      const { playlists, total } = await window.chksz.music.searchNeteasePlaylists(keyword, PLAYLIST_PAGE)
      if (seq !== discoverSeq.current) return
      setDiscover(playlists)
      setDiscoverTotal(total)
    } catch (error) {
      if (seq !== discoverSeq.current) return
      setDiscover(null)
      setDiscoverTotal(null)
      setDiscoverMessage(error instanceof Error ? error.message : '搜索失败，请重试')
    } finally {
      if (seq === discoverSeq.current) setDiscoverLoading(false)
    }
  }

  /** 搜索发现翻页：继续用当前关键词拉下一页追加。 */
  const loadMoreDiscover = async () => {
    if (!discover || discover.length === 0 || discoverLoading) return
    const seq = discoverSeq.current
    const offset = discover.length
    setDiscoverLoading(true)
    try {
      const { playlists, total } = await window.chksz.music.searchNeteasePlaylists(discoverQuery.trim(), PLAYLIST_PAGE, offset)
      if (seq !== discoverSeq.current) return
      if (playlists.length === 0) {
        // 翻到底：把总数收敛到当前已加载量，「加载更多」立即消失，避免死循环。
        setDiscoverTotal(prev => (prev === null ? 0 : Math.min(prev, offset)))
        return
      }
      setDiscover(prev => (prev ? [...prev, ...playlists] : playlists))
      // total 每次请求都可能变化，翻页时用最新值刷新。
      setDiscoverTotal(total)
    } catch {
      // 翻页失败保留已有结果即可。
    } finally {
      if (seq === discoverSeq.current) setDiscoverLoading(false)
    }
  }

  const recents = library?.neteaseImports ?? []

  return (
    <section className="playlists-page">
      <header className="page-heading">
        <h1>歌单</h1>
        <span>本地歌单与网易云导入</span>
      </header>

      {/* 页内标签：我的歌单 / 网易云歌单（常驻渲染，CSS 隐显以保留各 tab 状态） */}
      <div className="page-tabs" role="tablist" aria-label="歌单分类">
        <button
          type="button"
          className={`page-tab${pageTab === 'netease' ? ' active' : ''}`}
          role="tab"
          aria-selected={pageTab === 'netease'}
          aria-controls="playlists-pane-netease"
          onClick={() => setPageTab('netease')}
        >
          网易云歌单
        </button>
        <button
          type="button"
          className={`page-tab${pageTab === 'mine' ? ' active' : ''}`}
          role="tab"
          aria-selected={pageTab === 'mine'}
          aria-controls="playlists-pane-mine"
          onClick={() => setPageTab('mine')}
        >
          我的歌单
        </button>
      </div>

      {/* 我的歌单 */}
      <section id="playlists-pane-mine" className="playlists-block" hidden={pageTab !== 'mine'}>
        <form className="inline-form" onSubmit={create}>
          <input aria-label="新歌单名称" value={createName} onChange={event => setCreateName(event.target.value)} placeholder="新歌单名称" />
          <button type="submit" className="primary-button small" disabled={!createName.trim()} aria-label="新建歌单">
            <ListIcon />
            新建
          </button>
        </form>
        {playlists.length === 0 ? (
          <div className="list-status small">还没有歌单，新建一个开始整理</div>
        ) : (
          <ul className="playlist-nav-list">
            {playlists.map(item => (
              <li key={item.id} className="playlist-nav">
                <button type="button" className="playlist-nav-main" onClick={() => openPlaylistDetail(item.id, 'local')}>
                  <ListIcon />
                  <span className="playlist-nav-name">{item.name}</span>
                  <span className="playlist-nav-count">{item.songs.length}</span>
                </button>
                <button type="button" className="playlist-nav-delete" onClick={() => setConfirmDelete(item)} aria-label={`删除 ${item.name}`}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 网易云歌单：合并的搜索/导入输入框 + 结果 + 最近导入 */}
      <section id="playlists-pane-netease" className="playlists-block" hidden={pageTab !== 'netease'}>
        <form className="inline-form" onSubmit={submitDiscover} role="search" aria-label="搜索或导入网易云歌单">
          <input aria-label="搜索或粘贴歌单 ID / 链接" value={discoverQuery} onChange={event => setDiscoverQuery(event.target.value)} placeholder="搜索歌单，或粘贴 ID / 链接导入" />
          <button type="submit" className="primary-button small" disabled={!discoverQuery.trim() || discoverLoading || importing}>
            {discoverLoading || importing ? <LoaderIcon className="spin" /> : <SearchIcon />}
            {importing ? '导入中…' : '搜索'}
          </button>
        </form>
        {message && <p className="inline-error">{message}</p>}
        {discoverMessage && !discoverLoading && (
          <ErrorNotice message={discoverMessage} onRetry={() => void submitDiscover()} />
        )}
        {discover && discover.length === 0 && !discoverLoading && (
          <p className="inline-error">没有找到相关歌单</p>
        )}
        {discover && discover.length > 0 && (
          <>
            <ul className="recents-list">
              {discover.map(item => (
                <li key={item.id} className="recents-item">
                  <button type="button" className="recents-open" onClick={() => openPlaylistDetail(item.id)}>
                    <span className="recents-cover">{item.cover ? <img src={item.cover} alt="" /> : <span className="cover-fallback netease">云</span>}</span>
                    <span className="recents-meta">
                      <strong>{item.name}</strong>
                      <span>{item.creator || '网易用户'} · {item.trackCount} 首{item.playCount ? ` · ${(item.playCount / 10000).toFixed(1)}万播放` : ''}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {discoverTotal !== null && discover.length < discoverTotal && (
              <button type="button" className="load-more" onClick={() => void loadMoreDiscover()} disabled={discoverLoading}>
                {discoverLoading ? '加载中…' : '加载更多'}
              </button>
            )}
          </>
        )}
        {recents.length > 0 && (
          <>
            <h3 className="sub-block-title">最近导入</h3>
            <ul className="recents-list">
              {recents.map(item => (
                <li key={item.sourceId} className="recents-item">
                  <button type="button" className="recents-open" onClick={() => openPlaylistDetail(item.sourceId)}>
                    <span className="recents-cover">{item.cover ? <img src={item.cover} alt="" /> : <span className="cover-fallback netease">云</span>}</span>
                    <span className="recents-meta">
                      <strong>{item.name || item.sourceId}</strong>
                      <span>{item.creator || '网易用户'} · {item.songCount} 首</span>
                    </span>
                  </button>
                  <button type="button" className="recents-play" onClick={() => { if (item.songs.length) player.playSongs(item.songs, 0) }} aria-label={`播放 ${item.name}`}>
                    {PlayIcon}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* 删除确认 */}
      {confirmDelete && (
        <div className="confirm-overlay" role="dialog" aria-modal="true">
          <div className="confirm-box">
            <h3>删除「{confirmDelete.name}」？</h3>
            <p>歌单内的歌曲会被移除，收藏不受影响。</p>
            <div className="confirm-actions">
              <button type="button" className="ghost-button" onClick={() => setConfirmDelete(null)}>取消</button>
              <button
                type="button"
                className="danger-button"
                onClick={() => {
                  void (async () => {
                    try {
                      const snapshot = await window.chksz.library.deletePlaylist(confirmDelete.id)
                      dispatch({ type: 'libraryChanged', library: snapshot })
                      setConfirmDelete(null)
                    } catch (error) {
                      setMessage(error instanceof Error ? error.message : '删除歌单失败')
                    }
                  })()
                }}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
