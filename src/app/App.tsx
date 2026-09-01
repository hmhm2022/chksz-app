import { useCallback, useEffect, useRef, useState } from 'react'
import { AppProvider, useAppState } from './AppState'
import { OverlayProvider, useOverlayRegistry } from './overlays'
import { PlayerProvider, usePlayer } from '../player/usePlayer'
import { DownloadsProvider } from '../downloads/store'
import { PlayerBar } from '../components/PlayerBar'
import { TabBar } from '../components/TabBar'
import { FirstRun } from '../features/settings/FirstRun'
import { DiscoverPage } from '../pages/DiscoverPage'
import { SearchPage } from '../pages/SearchPage'
import { PlaylistDetailPage } from '../pages/PlaylistDetailPage'
import { NowPlayingPage } from '../pages/NowPlayingPage'
import { DownloadsPage } from '../pages/DownloadsPage'
import { HistoryPage } from '../pages/HistoryPage'
import { FavoritesPage } from '../pages/FavoritesPage'
import { PlaylistsPage } from '../pages/PlaylistsPage'
import { ProfilePage } from '../pages/ProfilePage'
import { SettingsPage } from '../pages/SettingsPage'
import { MusicIcon } from '../components/icons'
import { ExitConfirmDialog } from '../components/ExitConfirmDialog'
import { systemBridge } from '../systemBridge'

/**
 * 页内容：view 非 home 时渲染二级页面（覆盖 TabBar 的沉浸页）；
 * view=home 时按当前 tab 渲染主内容。二级页面与 tab 内容互斥（简单导航，无页面栈）。
 */
function renderPage(dispatch: ReturnType<typeof useAppState>['dispatch'], state: ReturnType<typeof useAppState>['state']) {
  switch (state.view) {
    // 二级页统一走返回栈：onBack = closeView（pop 回栈顶/上一级），onOpenSettings = openView 入栈。
    case 'search':
      return <SearchPage onBack={() => dispatch({ type: 'closeView' })} onOpenSettings={() => dispatch({ type: 'openView', view: 'settings' })} />
    case 'playlist-detail':
      return <PlaylistDetailPage playlistId={state.playlistId} kind={state.playlistDetail.kind} onBack={() => dispatch({ type: 'closeView' })} onOpenSettings={() => dispatch({ type: 'openView', view: 'settings' })} />
    case 'now-playing':
      return <NowPlayingPage onClose={() => dispatch({ type: 'closeView' })} onOpenSettings={() => dispatch({ type: 'openView', view: 'settings' })} />
    case 'settings':
      return <SettingsPage onBack={() => dispatch({ type: 'closeView' })} />
    case 'downloads':
      return <DownloadsPage onBack={() => dispatch({ type: 'closeView' })} />
    case 'history':
      return <HistoryPage onBack={() => dispatch({ type: 'closeView' })} />
    case 'home': {
      switch (state.tab) {
        case 'discover':
          return (
            <DiscoverPage
              openSearch={(platform) => dispatch({ type: 'openSearch', platform })}
              openPlaylistDetail={(playlistId) => dispatch({ type: 'openPlaylist', playlistId, kind: 'netease' })}
              onOpenSettings={() => dispatch({ type: 'openView', view: 'settings' })}
            />
          )
        case 'playlists':
          return <PlaylistsPage openPlaylistDetail={(playlistId, kind = 'netease') => dispatch({ type: 'openPlaylist', playlistId, kind })} />
        case 'favorites':
          return <FavoritesPage />
        case 'profile':
          return <ProfilePage openSettings={() => dispatch({ type: 'openView', view: 'settings' })} openDownloads={() => dispatch({ type: 'openView', view: 'downloads' })} openHistory={() => dispatch({ type: 'openView', view: 'history' })} />
      }
    }
  }
}

function AppShell() {
  const { state, dispatch } = useAppState()
  const player = usePlayer()
  const overlays = useOverlayRegistry()
  const immersive = state.view === 'now-playing'
  // 二级页面（搜索/详情/设置）仍保留 TabBar 便于回到发现；播放页为沉浸模式隐藏底部条。
  const showBottomBar = !immersive

  /**
   * 系统返回键统一入口（原生 backButton 事件 / 未来浏览器 popstate 共用）：
   * 1. 有全局浮层（音质/音量/导入/播放器歌词/队列）→ 先关最上层，返回键不触达页面导航；
   * 2. 无浮层 → dispatch hardwareBack：二级页逐级返回 / home 直接置 backNeedsExit（退出）。
   */
  const handleHardwareBack = useCallback(() => {
    // 播放器歌词/队列浮层虽在 AppState 之外，但也是「浮层优先」的一环，先关它们。
    if (player.closeTopOverlay()) return
    if (overlays.closeTop()) return
    dispatch({ type: 'hardwareBack' })
  }, [player, overlays, dispatch])

  // 消费 backNeedsExit：确认框点「退出」后真正退出 App。
  useEffect(() => {
    if (!state.backNeedsExit) return
    // 浏览器 dev 下桥是 Unimplemented，静默忽略即可（此时不退出，保持可调试）。
    void systemBridge.exitApp().catch(() => {})
  }, [state.backNeedsExit])

  // 退出确认框注册进 overlay 注册表：确认框开着时返回键先关它（等同「再按返回=取消」）。
  useEffect(() => state.confirmExit
    ? overlays.register({ id: 'exit-confirm', close: () => dispatch({ type: 'confirmExitDismissed' }) })
    : undefined, [state.confirmExit, overlays, dispatch])

  // 订阅原生返回键（Android 专属；浏览器 dev 下 addListener reject，忽略以免重复注册）。
  // 用 ref 持有最新 handler：避免 player/overlays 每次渲染换对象导致 effect 反复 remove/add。
  const backHandlerRef = useRef(handleHardwareBack)
  backHandlerRef.current = handleHardwareBack
  useEffect(() => {
    let handle: { remove: () => Promise<void> } | undefined
    systemBridge.onBackButton(() => backHandlerRef.current())
      .then((h) => { handle = h })
      .catch(() => {})
    return () => { void handle?.remove() }
  }, [])

  return (
    <div className={`app-shell${immersive ? ' immersive' : ''}`}>
      <main className="main-content">{renderPage(dispatch, state)}</main>
      {showBottomBar && (
        <div className="bottom-bar">
          {/* 无歌时只保留 TabBar：播放条仅在有播放目标时出现，不占空位。 */}
          {player.currentSong && (
            <PlayerBar onExpand={() => dispatch({ type: 'openView', view: 'now-playing' })} onOpenSettings={() => dispatch({ type: 'openView', view: 'settings' })} />
          )}
          <TabBar
            tab={state.tab}
            onChange={(tab) => {
              // 切 tab：reducer 会记住当前 tab 的视图、并恢复目标 tab 的记忆视图
              // （如歌单 tab 曾停在详情页，切走再切回自动回到详情）。无需再强制回 home。
              dispatch({ type: 'tabChanged', tab })
            }}
          />
        </div>
      )}
      {/* 整单播放失败自动跳过：全局短暂提示（复用 toast 样式，避免覆盖 PlayerBar 加载提示）。 */}
      {player.skipNotice && (
        <div className="toast" role="status">{player.skipNotice}</div>
      )}
      {/* 退出确认框：home 按返回弹出，确认才真正退出（防误触）。 */}
      {state.confirmExit && (
        <ExitConfirmDialog
          onConfirm={() => dispatch({ type: 'confirmExitConfirmed' })}
          onCancel={() => dispatch({ type: 'confirmExitDismissed' })}
        />
      )}
    </div>
  )
}

function AppContent() {
  const { state, reload } = useAppState()
  const [needsSetup, setNeedsSetup] = useState(false)

  useEffect(() => {
    const checkSetup = async () => {
      if (!state.initialized || !state.hasKey) return
      const settings = await window.chksz.settings.get()
      if (!settings.apiBaseUrl) {
        setNeedsSetup(true)
      }
    }
    void checkSetup()
  }, [state.initialized, state.hasKey])

  if (!state.initialized) {
    return (
      <div className="boot-screen">
        <div className="boot-disc" aria-hidden="true">
          <span className="boot-disc-groove" />
          <span className="boot-disc-groove-inner" />
          <MusicIcon className="boot-note" />
          <span className="boot-spindle" />
        </div>
        <div className="boot-meta">
          <strong className="boot-brand">CHKSZ Music</strong>
          <p>正在读取本地设置</p>
        </div>
      </div>
    )
  }
  if (state.initializationError) {
    return (
      <div className="boot-screen">
        <div className="boot-actions">
          <h1>无法读取本地资料</h1>
          <p>{state.initializationError}</p>
          <button className="primary-button" type="button" onClick={() => void reload()}>
            重新读取
          </button>
        </div>
      </div>
    )
  }
  if (!state.hasKey || needsSetup) return <FirstRun />
  return <AppShell />
}

export function App() {
  return (
    <AppProvider>
      <OverlayProvider>
        <DownloadsProvider>
          {/* 播放核心：Provider 挂在最外层（含 FirstRun/初始化屏），保证 usePlayer 全局可用 */}
          <PlayerProvider>
            <AppContent />
          </PlayerProvider>
        </DownloadsProvider>
      </OverlayProvider>
    </AppProvider>
  )
}
