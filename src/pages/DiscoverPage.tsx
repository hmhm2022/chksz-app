import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { MusicPlatform, NeteasePlaylistSummary } from '@shared/contracts'
import { useAppState } from '../app/AppState'
import { ErrorNotice } from '../components/ErrorNotice'
import { LoaderIcon, SearchIcon } from '../components/icons'

const PLATFORMS: Array<{ id: MusicPlatform; label: string }> = [
  { id: 'netease', label: '网易云' },
  { id: 'qq', label: 'QQ' },
  { id: 'kugou', label: '酷狗' },
]

/**
 * 歌单分类：分组 → 细分类，组名对齐网易云官方五大类（语种/风格/场景/情感/主题）。
 * 细分类名在精品池与全量池接口均实测可用（catalogue 接口匿名态拿不到细分类，故硬编码）。
 */
const RECOMMEND_GROUPS: { name: string; cats: string[] }[] = [
  { name: '语种', cats: ['华语', '欧美', '粤语', '日语', '韩语'] },
  { name: '风格', cats: ['流行', '摇滚', '民谣', '电子', '舞曲', '说唱', '爵士', '乡村', 'R&B/Soul', '古典', '民族', '金属', '朋克', '蓝调', '雷鬼', '世界音乐', '拉丁', '古风', '后摇', '英伦', '轻音乐'] },
  { name: '场景', cats: ['夜晚', '学习', '工作', '下午茶', '地铁', '驾车', '运动', '旅行', '散步', '酒吧'] },
  { name: '情感', cats: ['怀旧', '清新', '浪漫', '伤感', '放松', '孤独', '感动', '兴奋', '快乐', '安静', '思念', '治愈'] },
  { name: '主题', cats: ['90后', '儿童', '校园', '经典', '网络歌曲', '翻唱', '吉他', '钢琴', '器乐', '榜单', 'KTV', '影视原声', 'ACG', '游戏', '70后', '80后', '00后'] }
]

/** 无封面歌单卡片的文字占位。 */
const CoverPlaceholder = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </svg>
)

interface DiscoverPageProps {
  openSearch: (defaultPlatform: MusicPlatform) => void
  openPlaylistDetail: (playlistId: string) => void
  onOpenSettings?: () => void
}

/** 单页展示量：主列表每次追加 / 前端切片每页张数。 */
const PAGE_SIZE = 12

/** 「全部」视图的三个可切换分区。 */
type HomeTab = 'recommend' | 'toplist' | 'featured'

const HOME_TABS: Array<{ id: HomeTab; label: string }> = [
  { id: 'recommend', label: '推荐' },
  { id: 'toplist', label: '榜单' },
  { id: 'featured', label: '精选' },
]

/**
 * DiscoverPage —— 发现 tab。
 * 顶部常驻搜索框 + 平台 chips + 分类 chips；内容按视图分层：
 * - 「全部」视图：三个可切换分区 tab（推荐/榜单/精选），默认「推荐」（延续原首屏第一区的认知）。
 *   推荐与榜单接口均无服务端分页（上限约 30 条 / 固定 63 个榜），进页面一次拉全量缓存，
 *   前端按 PAGE_SIZE 切片 + 加载更多；精选走精品池 lasttime 服务端游标翻页。切 tab 不重新拉取。
 * - 选中细分标签：单列表（无 tab 行），数据源为全量公开歌单按热度（cat + offset 翻页，海量、每类都有货）。
 * 快速切换分类用 seq 序号 + currentCat 引用双保险防串台。
 */
export function DiscoverPage({ openSearch, openPlaylistDetail, onOpenSettings }: DiscoverPageProps) {
  const { state } = useAppState()
  const [platform, setPlatform] = useState<MusicPlatform>(state.settings?.defaultPlatform ?? 'netease')
  const [cat, setCat] = useState('全部')
  /** 手风琴展开的分组名（null 收起）；展开/收起不触发加载，选中细分类才重新拉取。 */
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  /** 「全部」视图当前分区（默认推荐——原首屏第一个区就是它）。 */
  const [homeTab, setHomeTab] = useState<HomeTab>('recommend')
  /** 主列表（精选 tab=精品池 lasttime 游标 / 细分类=全量热门池 offset）。 */
  const [items, setItems] = useState<NeteasePlaylistSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  /** 推荐 feed 全量缓存（无分页，一次拉满约 30 条）。 */
  const [recs, setRecs] = useState<NeteasePlaylistSummary[]>([])
  const [recsDone, setRecsDone] = useState(false)
  const [recsError, setRecsError] = useState('')
  /** 推荐已展示张数（前端切片翻页）。 */
  const [recsShown, setRecsShown] = useState(PAGE_SIZE)
  /** 官方榜单全量缓存（固定 60+ 个榜）。 */
  const [tops, setTops] = useState<Array<{ id: string; name: string; cover: string }>>([])
  const [topsDone, setTopsDone] = useState(false)
  const [topsError, setTopsError] = useState('')
  /** 榜单已展示个数（前端切片翻页）。 */
  const [topsShown, setTopsShown] = useState(PAGE_SIZE)
  /** 竞态序号：防止慢响应覆盖新请求（切分类 / 切 tab 重新挂载都靠它）。 */
  const seq = useRef(0)
  const recsRequest = useRef(0)
  const topsRequest = useRef(0)
  /** 当前分类引用：changeCat 里同步更新，用于作废「切分类后、effect 重跑前」落地的旧响应。 */
  const currentCat = useRef(cat)

  useEffect(() => {
    if (state.settings) setPlatform(state.settings.defaultPlatform)
  }, [state.settings?.defaultPlatform])

  /**
   * 主列表加载：cat=全部 走精品池（before 游标=末尾 updateTime 追加）；
   * 细分类走全量热门池（offset=已加载数量追加）。数据源不同但渲染与竞态防护同构。
   */
  const loadMain = useCallback(async (targetCat: string, cursor: number, append: boolean) => {
    const id = ++seq.current
    setLoading(true)
    setError('')
    try {
      const result = targetCat === '全部'
        ? await window.chksz.music.recommendNeteasePlaylists(targetCat, PAGE_SIZE, cursor)
        : await window.chksz.music.hotNeteasePlaylists(targetCat, PAGE_SIZE, cursor)
      // 双保险：seq 作废前序请求；分类引用作废「切分类后、effect 重跑前」落地的旧 loadMore 响应。
      if (id !== seq.current || targetCat !== currentCat.current) return
      setTotal(result.total)
      setItems(prev => (append ? [...prev, ...result.playlists] : result.playlists))
    } catch (loadError) {
      if (id !== seq.current || targetCat !== currentCat.current) return
      // 接口失效：仅在无既有结果时提示，有结果则静默保留（不影响浏览）。
      setError(loadError instanceof Error ? loadError.message : '歌单加载失败')
    } finally {
      if (id === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadMain(cat, 0, false)
  }, [cat, loadMain])

  /** 推荐 feed 与官方榜单：进页面一次拉全量并缓存；失败保留错误，允许单区重试。 */
  const loadRecs = useCallback(async () => {
    const id = ++recsRequest.current
    setRecsDone(false)
    setRecsError('')
    try {
      const list = await window.chksz.music.personalizedPlaylists(30)
      if (id !== recsRequest.current) return
      setRecs(list)
    } catch (loadError) {
      if (id !== recsRequest.current) return
      setRecsError(loadError instanceof Error ? loadError.message : '推荐歌单加载失败')
    } finally {
      if (id === recsRequest.current) setRecsDone(true)
    }
  }, [])

  const loadTops = useCallback(async () => {
    const id = ++topsRequest.current
    setTopsDone(false)
    setTopsError('')
    try {
      const list = await window.chksz.music.toplists()
      if (id !== topsRequest.current) return
      setTops(list)
    } catch (loadError) {
      if (id !== topsRequest.current) return
      setTopsError(loadError instanceof Error ? loadError.message : '官方榜单加载失败')
    } finally {
      if (id === topsRequest.current) setTopsDone(true)
    }
  }, [])

  useEffect(() => {
    void loadRecs()
    void loadTops()
  }, [loadRecs, loadTops])

  /** 切分类：立即作废在途请求并同步分类引用，重置列表后重新加载（杜绝旧响应 append 串台）。 */
  const changeCat = (next: string) => {
    if (next === cat) return
    seq.current += 1
    currentCat.current = next
    setCat(next)
    setItems([])
    setTotal(0)
    if (next === '全部') setOpenGroup(null)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    openSearch(platform)
  }

  /** 切换分组手风琴展开/收起（不触发数据加载）。 */
  const toggleGroup = (name: string) => setOpenGroup(prev => (prev === name ? null : name))

  const loadMore = () => {
    if (items.length === 0) return
    // 精品池游标 = 末尾 updateTime；全量池游标 = 已加载条数（offset）。
    const cursor = cat === '全部' ? (items[items.length - 1]?.updateTime ?? 0) : items.length
    void loadMain(cat, cursor, true)
  }

  /** 卡片网格：复用现有 playlist-grid/playlist-card 样式。榜单摘要缺省字段用空值兜底。 */
  const renderGrid = (list: Array<{ id: string; name: string; cover: string; creator?: string; playCount?: number; trackCount?: number }>) => (
    <div className="playlist-grid">
      {list.map(item => (
        <button key={item.id} type="button" className="playlist-card" onClick={() => openPlaylistDetail(item.id)}>
          <span className="playlist-cover">
            {item.cover ? <img src={item.cover} alt="" loading="lazy" /> : CoverPlaceholder}
            {(item.trackCount ?? 0) > 0 && <span className="playlist-count">{item.trackCount} 首</span>}
          </span>
          <strong className="playlist-name">{item.name}</strong>
          <span className="playlist-meta">{item.creator || '网易用户'}{item.playCount ? ` · ${(item.playCount / 10000).toFixed(1)}万播放` : ''}</span>
        </button>
      ))}
    </div>
  )

  /** 主列表通用区块：加载中 / 错误重试 / 空态 / 网格 + 服务端翻页按钮。 */
  const renderMainList = (): ReactNode => (
    <>
      {loading && items.length === 0 && (
        <div className="list-status"><LoaderIcon className="spin" /><span>正在加载歌单</span></div>
      )}
      {!loading && error && items.length === 0 && (
        <ErrorNotice
          message={error}
          onOpenSettings={onOpenSettings}
          onRetry={() => void loadMain(cat, 0, false)}
        />
      )}
      {!loading && !error && items.length === 0 && (
        <div className="list-status">该分类暂无歌单，换个分类试试</div>
      )}
      {items.length > 0 && (
        <>
          {renderGrid(items)}
          {items.length < total && (
            <button type="button" className="load-more" onClick={loadMore} disabled={loading}>
              {loading ? '加载中…' : '加载更多'}
            </button>
          )}
        </>
      )}
    </>
  )

  /** 前端切片分区（推荐/榜单）：数据一次拉全量，这里只负责切片展示 + 本地加载更多。 */
  const renderFrontPaged = (
    list: Array<{ id: string; name: string; cover: string; creator?: string; playCount?: number; trackCount?: number }>,
    shown: number,
    onMore: () => void,
    done: boolean,
    error: string,
    onRetry: () => void,
    loadingLabel: string,
  ) => (
    <>
      {!done && (
        <div className="list-status"><LoaderIcon className="spin" /><span>{loadingLabel}</span></div>
      )}
      {done && error && list.length === 0 && (
        <ErrorNotice message={error} onOpenSettings={onOpenSettings} onRetry={onRetry} />
      )}
      {done && !error && list.length === 0 && (
        <div className="list-status">暂时没有内容，稍后再来看看</div>
      )}
      {list.length > 0 && renderGrid(list.slice(0, shown))}
      {list.length > shown && (
        <button type="button" className="load-more" onClick={onMore}>加载更多</button>
      )}
    </>
  )

  const isHome = cat === '全部'

  return (
    <section className="discover-page">
      <form className="discover-search" onSubmit={submit} role="search">
        <SearchIcon />
        <input aria-label="搜索歌曲" placeholder="搜索歌曲、歌手" readOnly onClick={submit} />
        <button type="submit" className="sr-only" aria-label="搜索">搜索</button>
      </form>
      <div className="platform-chips" role="group" aria-label="搜索平台">
        {PLATFORMS.map(item => (
          <button key={item.id} type="button" className={`platform-chip${platform === item.id ? ' active' : ''}`} onClick={() => setPlatform(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      <div className="category-chips" role="group" aria-label="精选分类">
        <button type="button" className={`category-chip${isHome ? ' active' : ''}`} onClick={() => changeCat('全部')}>全部</button>
        {RECOMMEND_GROUPS.map(group => (
          <button key={group.name} type="button" className={`category-chip${openGroup === group.name ? ' active' : ''}`} onClick={() => toggleGroup(group.name)}>
            {group.name}<span className="chip-arrow">{openGroup === group.name ? ' ▾' : ' ▸'}</span>
          </button>
        ))}
      </div>
      {openGroup && (
        <div className="category-chips category-sub" role="group" aria-label={`${openGroup}细分类`}>
          {RECOMMEND_GROUPS.find(group => group.name === openGroup)?.cats.map(item => (
            <button key={item} type="button" className={`category-chip${cat === item ? ' active' : ''}`} onClick={() => changeCat(item)}>
              {item}
            </button>
          ))}
        </div>
      )}
      <div className="discover-body">
        {/* —— 「全部」视图：分区切换 tab（样式复用 category-chip，零新增 CSS） —— */}
        {isHome && (
          <div className="category-chips" role="group" aria-label="全部视图分区">
            {HOME_TABS.map(tab => (
              <button key={tab.id} type="button" className={`category-chip${homeTab === tab.id ? ' active' : ''}`} onClick={() => setHomeTab(tab.id)}>
                {tab.label}
              </button>
            ))}
          </div>
        )}
        {isHome && homeTab === 'recommend' && (
          <>
            <header className="section-heading"><div><h1>为你推荐</h1><span>网易云个性化推荐 · 每次启动更新</span></div></header>
            {renderFrontPaged(recs, recsShown, () => setRecsShown(n => n + PAGE_SIZE), recsDone, recsError, () => void loadRecs(), '正在加载为你推荐')}
          </>
        )}
        {isHome && homeTab === 'toplist' && (
          <>
            <header className="section-heading"><div><h1>官方榜单</h1><span>网易云官方编制 · 定时更新</span></div></header>
            {renderFrontPaged(tops, topsShown, () => setTopsShown(n => n + PAGE_SIZE), topsDone, topsError, () => void loadTops(), '正在加载官方榜单')}
          </>
        )}
        {isHome && homeTab === 'featured' && (
          <>
            <header className="section-heading"><div><h1>编辑精选</h1><span>来自网易云编辑精品歌单</span></div></header>
            {renderMainList()}
          </>
        )}
        {!isHome && (
          <>
            <header className="section-heading">
              <div>
                <h1>分类歌单</h1>
                <span>来自网易云全量歌单 · {cat}</span>
              </div>
            </header>
            {renderMainList()}
          </>
        )}
      </div>
    </section>
  )
}
