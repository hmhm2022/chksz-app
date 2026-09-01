import { createContext, use, useCallback, useEffect, useReducer, type Dispatch, type ReactNode } from 'react'
import { AppError, type LibrarySnapshot, type MusicPlatform, type PlaylistRef, type Settings, type Song } from '@shared/contracts'

/**
 * 移动版 AppState —— 参照桌面版 AppState（chksz-desktop/src/renderer/src/app/AppState.tsx）。
 * 搜索状态同样存全局 reducer（每平台一个结果槽）；歌单详情状态也升全局：
 * 移动端页面是「进二级页/返回」的挂载-卸载模式（桌面端是常驻页），
 * 结果/输入若放组件内 state 会在切页时整个丢失，升到全局后切走再切回原样恢复。
 */

/** 搜索页当前平台（SearchPage chips 切换，reducer 按它定位结果槽）。 */
export type SearchPlatform = MusicPlatform

/** 搜索状态槽：每平台一份 status/query/songs/message，切平台不互相清空。 */
export interface SearchState {
  status: 'idle' | 'loading' | 'success' | 'error'
  query: string
  songs: Song[]
  message: string
  /** 搜索失败的错误码（AppError.code），用于错误引导（密钥无效/免费源失效跳设置）。 */
  errorCode?: AppError['code']
}

const emptySearch = (): SearchState => ({ status: 'idle', query: '', songs: [], message: '' })

/** 歌单详情的数据来源：网易云线上歌单 / 本地自建歌单。 */
export type PlaylistKind = 'netease' | 'local'

/** 歌单详情全局状态：切 tab/切页组件卸载后，数据保留在全局，切回原样恢复（对齐桌面版 neteasePlaylist.loaded）。 */
export interface PlaylistDetailState {
  /** 当前打开的歌单 ID。 */
  playlistId: string
  /** 歌单数据来源（本地歌单从 library 读，网易歌单走线上/缓存）。 */
  kind: PlaylistKind
  /** 当前详情请求编号；刷新同一个歌单时用它拒绝旧响应。 */
  requestId: string
  /** 已加载的歌单数据；null 表示尚未加载。 */
  playlist: PlaylistRef | null
  loading: boolean
  error: string
  /** 读取失败的错误码（AppError.code），用于错误引导。 */
  errorCode?: AppError['code']
}

const emptyPlaylistDetail = (): PlaylistDetailState => ({ playlistId: '', kind: 'netease', requestId: '', playlist: null, loading: false, error: '' })

export type TabId = 'discover' | 'playlists' | 'favorites' | 'profile'
/**
 * 当前页面视图：四个 tab 对应 'home'（呈现当前 tab 内容），
 * 其余为覆盖在 tab 之上的二级页面（搜索 / 歌单详情 / 全屏播放 / 设置 / 下载管理）。
 * 轻量导航方案：不用 react-router，AppState 单字段 + 参数即可（Task 7 约定）。
 */
export type AppView =
  | 'home'
  | 'search'
  | 'playlist-detail'
  | 'now-playing'
  | 'settings'
  | 'downloads'
  | 'history'

/** 导航栈条目：二级页 + 参数。view 为 home 时栈为空（不变量）。 */
export interface AppNavEntry {
  view: Exclude<AppView, 'home'>
  /** playlist-detail 歌单 ID。 */
  playlistId?: string
  /** playlist-detail 歌单数据来源（本地自建 / 网易线上）。 */
  kind?: PlaylistKind
}

export interface AppState {
  initialized: boolean
  initializationError: string
  hasKey: boolean
  tab: TabId
  view: AppView
  /** 每 tab 独立的二级页返回栈（栈顶 = 当前二级页；空 ⟺ view === 'home'）。 */
  nav: Record<TabId, AppNavEntry[]>
  /** home 返回键弹出退出确认框时为 true（防误触）；确认后置 backNeedsExit 退出。 */
  confirmExit: boolean
  /** 确认退出后置 true，UI 层消费后真正退出 App。 */
  backNeedsExit: boolean
  /** 每个 tab 各自最后停留的视图：切走再切回时恢复（如歌单 tab 停在详情页）。 */
  tabView: Record<TabId, AppView>
  /** 搜索页当前平台（SearchPage 内 chips / DiscoverPage 入口 chips 切换）。 */
  searchPlatform: MusicPlatform
  /** 歌单详情页当前歌单 ID（导航参数）。 */
  playlistId: string
  /** 歌单详情全局状态：切页/切 tab 后仍保留已加载数据，切回恢复。 */
  playlistDetail: PlaylistDetailState
  settings: Settings | null
  library: LibrarySnapshot | null
  /** 搜索状态槽：每平台独立 + 组件卸载后切回仍恢复。 */
  search: Record<MusicPlatform, SearchState>
  /** 搜索竞态序号：页面卸载重挂时组件 useRef 会归零，故提到全局（防旧响应覆盖新搜索结果）。 */
  searchSeq: number
  /** ChKSz 免费额度剩余次数；未获取到为 null。 */
  freeQuota: number | null
}

export type AppAction =
  | { type: 'initializationStarted' }
  | { type: 'initialized'; hasKey: boolean; settings?: Settings | null; library?: LibrarySnapshot | null }
  | { type: 'initializationFailed'; message: string }
  | { type: 'tabChanged'; tab: TabId }
  /** 打开二级页：push 到当前 tab 栈。 */
  | { type: 'openView'; view: Exclude<AppView, 'home'>; playlistId?: string }
  /** 关闭当前二级页：pop 当前 tab 栈，恢复栈顶（或 home）。 */
  | { type: 'closeView' }
  /** 系统返回键驱动：栈非空则逐级返回；home 弹出退出确认框（防误触）。 */
  | { type: 'hardwareBack' }
  /** 退出确认框：取消/点遮罩关闭（返回键也可触发 closeTopOverlay 关它）。 */
  | { type: 'confirmExitDismissed' }
  /** 退出确认框：确认，真正置 backNeedsExit 退出。 */
  | { type: 'confirmExitConfirmed' }
  /** 遗留兼容（仅历史状态迁移/特殊场景用，新代码统一走 openView/closeView）。 */
  | { type: 'viewChanged'; view: AppView }
  | { type: 'openSearch'; platform: MusicPlatform }
  | { type: 'openPlaylist'; playlistId: string; kind: PlaylistKind }
  /** 歌单详情开始加载（切换歌单时清空旧详情，避免闪旧数据）。 */
  | { type: 'playlistDetailStarted'; playlistId: string; kind: PlaylistKind; requestId: string }
  /** 歌单详情加载成功。 */
  | { type: 'playlistDetailSucceeded'; playlistId: string; kind: PlaylistKind; requestId: string; playlist: PlaylistRef }
  /** 歌单详情加载失败。 */
  | { type: 'playlistDetailFailed'; playlistId: string; kind: PlaylistKind; requestId: string; message: string; errorCode?: AppError['code'] }
  | { type: 'libraryChanged'; library: LibrarySnapshot }
  | { type: 'settingsChanged'; settings: Settings }
  | { type: 'quotaUpdated'; freeQuota: number | null }
  /** 搜索页内切换平台 chips。 */
  | { type: 'searchPlatformChanged'; platform: MusicPlatform }
  /** 输入框内容变化：写回当前 searchPlatform 槽（切页回来输入框保留）。 */
  | { type: 'searchQueryChanged'; query: string }
  /** 发起搜索：目标槽 = 当前 searchPlatform，query 一并入槽（切页回来输入框保留）。 */
  | { type: 'searchStarted'; query: string }
  /** 搜索成功：仅写入仍属于发起时平台和序号的结果槽。 */
  | { type: 'searchSucceeded'; platform: MusicPlatform; seq: number; songs: Song[] }
  /** 搜索失败：仅写入仍属于发起时平台和序号的结果槽。 */
  | { type: 'searchFailed'; platform: MusicPlatform; seq: number; message: string; errorCode?: AppError['code'] }
  /** 收藏/取消收藏后：同步搜索结果槽里该平台的歌曲（列表即时反映操作），并广播新库快照。 */
  | { type: 'searchCompleted'; platform: MusicPlatform; songs: Song[]; library: LibrarySnapshot }

export const initialState: AppState = {
  initialized: false,
  initializationError: '',
  hasKey: false,
  tab: 'discover',
  view: 'home',
  nav: { discover: [], playlists: [], favorites: [], profile: [] },
  confirmExit: false,
  backNeedsExit: false,
  tabView: { discover: 'home', playlists: 'home', favorites: 'home', profile: 'home' },
  searchPlatform: 'netease',
  playlistId: '',
  playlistDetail: emptyPlaylistDetail(),
  settings: null,
  library: null,
  search: { netease: emptySearch(), qq: emptySearch(), kugou: emptySearch() },
  searchSeq: 0,
  freeQuota: null,
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'initializationStarted':
      return { ...state, initialized: false, initializationError: '' }
    case 'initialized':
      return {
        ...state,
        initialized: true,
        initializationError: '',
        hasKey: action.hasKey,
        settings: action.settings ?? state.settings,
        library: action.library ?? state.library,
      }
    case 'initializationFailed':
      return { ...state, initialized: true, initializationError: action.message }
    case 'tabChanged':
      // 切走前把当前 tab 的视图存回记忆；切到目标 tab 时恢复其最后视图（无记忆则 home）。
      return {
        ...state,
        tab: action.tab,
        view: state.tabView[action.tab],
        tabView: { ...state.tabView, [state.tab]: state.view },
      }
    case 'openView':
      // push 到当前 tab 栈：view 与栈顶一致，tabView 同步记忆；playlist-detail 参数同步顶层 playlistId。
      return {
        ...state,
        view: action.view,
        playlistId: action.view === 'playlist-detail' ? (action.playlistId ?? '') : state.playlistId,
        tabView: { ...state.tabView, [state.tab]: action.view },
        nav: {
          ...state.nav,
          [state.tab]: [...state.nav[state.tab], { view: action.view, playlistId: action.playlistId }],
        },
      }
    case 'closeView':
      // pop 栈：恢复栈顶（home）；栈空则幂等 no-op（默认 AppCompatActivity finish 由原生层兜底，reducer 不越权）。
      return closeView(state)
    case 'hardwareBack':
      return hardwareBack(state)
    case 'confirmExitDismissed':
      // 取消退出：关确认框，留在 App（返回键/点取消/点遮罩都可触发）。
      return { ...state, confirmExit: false, backNeedsExit: false }
    case 'confirmExitConfirmed':
      // 确认退出：关确认框并置退出标志，UI 层消费后真正退出。
      return { ...state, confirmExit: false, backNeedsExit: true }
    case 'viewChanged':
      // 每个 tab 记住自己最后停留的视图（含 home）：切走再切回时按记忆恢复。
      return { ...state, view: action.view, tabView: { ...state.tabView, [state.tab]: action.view } }
    case 'openSearch':
      // 打开搜索：push 到当前 tab 栈 + 设置初始平台（searchPlatform 决定搜索槽）。
      return {
        ...state,
        view: 'search',
        searchPlatform: action.platform,
        // 每次重新进入都创建新的搜索上下文，作废已卸载页面留下的同平台请求。
        searchSeq: state.searchSeq + 1,
        tabView: { ...state.tabView, [state.tab]: 'search' },
        nav: {
          ...state.nav,
          [state.tab]: [...state.nav[state.tab], { view: 'search' }],
        },
      }
    case 'searchPlatformChanged':
      // 切平台 = 一次新的搜索上下文：seq +1 作废在途旧请求（避免旧响应写进新平台槽）。
      return { ...state, searchPlatform: action.platform, searchSeq: state.searchSeq + 1 }
    case 'searchQueryChanged':
      return {
        ...state,
        search: {
          ...state.search,
          [state.searchPlatform]: { ...state.search[state.searchPlatform], query: action.query },
        },
      }
    case 'openPlaylist':
      // 打开歌单详情：push 到当前 tab 栈 + 同步顶层 playlistId + 数据来源 kind。
      // 打开相同歌单（切走再切回）：保留已加载数据秒开；打开不同歌单/不同来源才重置。
      return {
        ...state,
        view: 'playlist-detail',
        playlistId: action.playlistId,
        tabView: { ...state.tabView, [state.tab]: 'playlist-detail' },
        nav: {
          ...state.nav,
          [state.tab]: [...state.nav[state.tab], { view: 'playlist-detail', playlistId: action.playlistId, kind: action.kind }],
        },
        playlistDetail: action.playlistId === state.playlistDetail.playlistId && action.kind === state.playlistDetail.kind
          ? { ...state.playlistDetail }
          : { ...emptyPlaylistDetail(), playlistId: action.playlistId, kind: action.kind },
      }
    case 'playlistDetailStarted':
      // 切换歌单时清空旧详情数据：避免加载新歌单时闪旧歌单内容。
      if (state.playlistDetail.playlistId !== action.playlistId || state.playlistDetail.kind !== action.kind) return state
      return {
        ...state,
        playlistDetail: { ...emptyPlaylistDetail(), playlistId: action.playlistId, kind: action.kind, requestId: action.requestId, loading: true },
      }
    case 'playlistDetailSucceeded':
      if (state.playlistDetail.playlistId !== action.playlistId || state.playlistDetail.kind !== action.kind || state.playlistDetail.requestId !== action.requestId) return state
      return {
        ...state,
        playlistDetail: { ...state.playlistDetail, loading: false, error: '', errorCode: undefined, playlist: action.playlist },
      }
    case 'playlistDetailFailed':
      if (state.playlistDetail.playlistId !== action.playlistId || state.playlistDetail.kind !== action.kind || state.playlistDetail.requestId !== action.requestId) return state
      return {
        ...state,
        playlistDetail: { ...state.playlistDetail, loading: false, error: action.message, errorCode: action.errorCode },
      }
    case 'searchStarted':
      // 注意：这里 _不_ 自增 searchSeq——同一平台重搜时新旧结果写同一槽，覆盖无害。
      // 只有 searchPlatformChanged（跨平台）才自增 seq 作废在途，避免旧响应写进新平台槽。
      return {
        ...state,
        search: {
          ...state.search,
          [state.searchPlatform]: { status: 'loading', query: action.query, songs: [], message: '正在搜索…', errorCode: undefined },
        },
      }
    case 'searchSucceeded':
      // 旧平台或旧上下文的响应不能写入当前槽，避免切换平台后串结果。
      if (state.searchPlatform !== action.platform || state.searchSeq !== action.seq) return state
      return {
        ...state,
        search: {
          ...state.search,
          [action.platform]: {
            ...state.search[action.platform],
            status: 'success',
            songs: action.songs,
            message: action.songs.length ? '' : '没有找到相关歌曲，换个关键词试试',
            errorCode: undefined,
          },
        },
      }
    case 'searchFailed':
      // 旧平台或旧上下文的响应不能写入当前槽，避免切换平台后串错误。
      if (state.searchPlatform !== action.platform || state.searchSeq !== action.seq) return state
      return {
        ...state,
        search: {
          ...state.search,
          [action.platform]: {
            ...state.search[action.platform],
            status: 'error',
            message: action.message,
            errorCode: action.errorCode,
          },
        },
      }
    case 'searchCompleted':
      return {
        ...state,
        search: {
          ...state.search,
          [action.platform]: {
            ...state.search[action.platform],
            songs: action.songs,
            status: action.songs.length ? 'success' : state.search[action.platform].status,
          },
        },
        library: action.library,
      }
    case 'libraryChanged':
      return { ...state, library: action.library }
    case 'settingsChanged':
      return { ...state, settings: action.settings }
    case 'quotaUpdated':
      return { ...state, freeQuota: action.freeQuota }
  }
}

/** closeView：pop 当前 tab 栈。栈空为幂等 no-op（确认框/退出标志同时复位）。 */
function closeView(state: AppState): AppState {
  const stack = state.nav[state.tab]
  if (stack.length === 0) {
    // 已处 home：closeView 不弹走任何页面，确认框与退出标志复位（退出语义由 hardwareBack/确认框接管）。
    return { ...state, confirmExit: false, backNeedsExit: false }
  }
  const next = stack.slice(0, -1)
  const top = next[next.length - 1]
  const view = top?.view ?? 'home'
  // 弹回歌单详情时恢复其歌单 ID 与数据来源（顶层 playlistId/kind 是渲染 PlaylistDetailPage 的唯一入口）。
  const restoreId = top?.view === 'playlist-detail' ? (top.playlistId ?? '') : ''
  const restoreKind = top?.view === 'playlist-detail' ? (top.kind ?? 'netease') : 'netease'
  return {
    ...state,
    view,
    playlistId: restoreId,
    playlistDetail: top?.view === 'playlist-detail'
      ? { ...state.playlistDetail, playlistId: restoreId, kind: restoreKind }
      : state.playlistDetail,
    confirmExit: false,
    backNeedsExit: false,
    tabView: { ...state.tabView, [state.tab]: view },
    nav: { ...state.nav, [state.tab]: next },
  }
}

/** hardwareBack：系统返回键——栈非空则逐级返回；栈空（home）弹退出确认框防误触。 */
function hardwareBack(state: AppState): AppState {
  // 确认框已开着：再按返回键当作「取消」关掉它（防连按直接退出）。
  if (state.confirmExit) return { ...state, confirmExit: false, backNeedsExit: false }

  const stack = state.nav[state.tab]
  if (stack.length > 0) return closeView(state)

  // home：先弹确认框，用户点确认才退出（不回溯 tab）。
  return { ...state, confirmExit: true, backNeedsExit: false }
}

interface AppContextValue {
  state: AppState
  dispatch: Dispatch<AppAction>
  reload: () => Promise<void>
  refreshQuota: () => Promise<void>
}

const AppContext = createContext<AppContextValue | null>(null)

/**
 * 本地数据加载（reload 核心逻辑），抽成纯函数便于 vitest 直接覆盖三条路径
 * （有密钥/无密钥/读失败），AppProvider 内仅作薄封装。
 */
export async function runReload(dispatch: Dispatch<AppAction>): Promise<void> {
  dispatch({ type: 'initializationStarted' })
  try {
    const hasKey = await window.chksz.credentials.hasKey()
    if (!hasKey) {
      dispatch({ type: 'initialized', hasKey: false })
      return
    }
    const [settings, library] = await Promise.all([
      window.chksz.settings.get(),
      window.chksz.library.get(),
    ])
    dispatch({ type: 'initialized', hasKey: true, settings, library })
    void runRefreshQuota(dispatch)
  } catch (error) {
    // 保留真实错误信息（AppError 带 code/message），错误屏可显示诊断信息。
    dispatch({
      type: 'initializationFailed',
      message: error instanceof Error ? error.message : '本地设置或资料库读取失败，请重试',
    })
  }
}

/** 免费额度刷新（ProfilePage 展示）。读 bridge 的 quota.get()：同日返回真实捕获值，跨日回落每日额度设置。抽成纯函数与 runReload 同理。 */
export async function runRefreshQuota(dispatch: Dispatch<AppAction>): Promise<void> {
  try {
    const freeQuota = await window.chksz.quota.get()
    dispatch({ type: 'quotaUpdated', freeQuota })
  } catch {
    // 拉取免费额度失败是预期行为：保持原值（如离线或额度接口不可用），不影响 App 使用。
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState)

  // 必须用 useCallback 钉住引用：PlayerProvider 每 500ms 随 onProgress 进度更新重渲染，
  // 若这里每次都是新函数，下游 applyState(useCallback 依赖它)跟着重建，播放器订阅
  // effect 与回前台对账 effect 会以同周期反复"注销→重注册"，每拍制造一个事件空窗——
  // onTrackAutoAdvanced 等一次性事件落在空窗即永久丢失（封面/歌词停在旧歌的总根源）。
  const reload = useCallback(() => runReload(dispatch), [dispatch])
  const refreshQuota = useCallback(() => runRefreshQuota(dispatch), [dispatch])

  useEffect(() => {
    void reload()
  }, [reload])

  return <AppContext value={{ state, dispatch, reload, refreshQuota }}>{children}</AppContext>
}

export function useAppState(): AppContextValue {
  const context = use(AppContext)
  if (!context) throw new Error('AppProvider is missing')
  return context
}
