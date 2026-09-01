import { describe, expect, it } from 'vitest'
import type { LibrarySnapshot, Settings, Song } from '@shared/contracts'
import { appReducer, initialState, type AppState } from './AppState'

const emptyLibrary: LibrarySnapshot = {
  favorites: [],
  history: [],
  playlists: [],
  neteaseImports: [],
}

const song: Song = {
  key: 'netease:1',
  platform: 'netease',
  id: '1',
  name: '晴天',
  artists: ['周杰伦'],
  album: '晴天',
  cover: '',
  duration: 269,
  qualities: ['standard'],
}

const baseSettings: Settings = {
  defaultPlatform: 'netease',
  neteaseQuality: 'lossless',
  qqQuality: 'flac',
  kugouQuality: 'flac',
  downloadDirectory: '',
  volume: 0.8,
  repeatMode: 'sequence',
  showCoverArt: true,
  neteaseSearchFree: true,
  qqSearchFree: true,
  kugouSearchFree: true,
  dailyQuota: 400,
  apiBaseUrl: '',
}

const settingsWith = (patch: Partial<Settings>): Settings => ({ ...baseSettings, ...patch })

describe('appReducer', () => {
  it('initializationStarted 将 initialized 重置为 false 并清空错误', () => {
    const state: AppState = { ...initialState, initialized: true, initializationError: '旧错误' }
    const next = appReducer(state, { type: 'initializationStarted' })
    expect(next.initialized).toBe(false)
    expect(next.initializationError).toBe('')
  })

  it('initialized(false) 标记完成但保持未授权', () => {
    const next = appReducer(initialState, { type: 'initialized', hasKey: false })
    expect(next.initialized).toBe(true)
    expect(next.hasKey).toBe(false)
    expect(next.tab).toBe('discover')
  })

  it('initialized(true) 写入 settings/library 并保持 tab', () => {
    const state: AppState = { ...initialState, tab: 'favorites' }
    const settings = settingsWith({ volume: 0.3 })
    const next = appReducer(state, {
      type: 'initialized',
      hasKey: true,
      settings,
      library: emptyLibrary,
    })
    expect(next.initialized).toBe(true)
    expect(next.hasKey).toBe(true)
    expect(next.settings).toBe(settings)
    expect(next.library).toBe(emptyLibrary)
    expect(next.tab).toBe('favorites')
  })

  it('tabChanged 切换当前 tab', () => {
    const next = appReducer(initialState, { type: 'tabChanged', tab: 'playlists' })
    expect(next.tab).toBe('playlists')
    expect(next.view).toBe('home')
  })

  it('tabChanged 记住切走前所在二級视图，切回时恢复（歌单详情→收藏→切回歌单自动回详情）', () => {
    // 场景：用户打开歌单详情（playlists tab 的 playlist-detail 视图）
    const inDetail: AppState = {
      ...initialState,
      tab: 'playlists',
      view: 'playlist-detail',
      tabView: { ...initialState.tabView, playlists: 'playlist-detail' },
      playlistId: '123',
    }
    // 切到收藏 tab
    const toFavorites = appReducer(inDetail, { type: 'tabChanged', tab: 'favorites' })
    expect(toFavorites.tab).toBe('favorites')
    expect(toFavorites.view).toBe('home')
    // 收藏 tab 自己尚未进二级页 → home；playlists 的记忆被保存
    expect(toFavorites.tabView.playlists).toBe('playlist-detail')
    expect(toFavorites.tabView.favorites).toBe('home')
    // 切回歌单 tab → 恢复 playlist-detail
    const backToPlaylists = appReducer({ ...toFavorites, view: 'home' }, { type: 'tabChanged', tab: 'playlists' })
    expect(backToPlaylists.tab).toBe('playlists')
    expect(backToPlaylists.view).toBe('playlist-detail')
    expect(backToPlaylists.playlistId).toBe('123')
  })

  it('tabChanged 新 tab 若曾停留二級页则恢复其视图', () => {
    // 发现 tab 停留在搜索页（view=search），切走再切回应恢复搜索
    const inSearch: AppState = {
      ...initialState,
      tab: 'discover',
      view: 'search',
      tabView: { ...initialState.tabView, discover: 'search' },
    }
    const toProfile = appReducer(inSearch, { type: 'tabChanged', tab: 'profile' })
    expect(toProfile.view).toBe('home')
    const backToDiscover = appReducer({ ...toProfile, view: 'home' }, { type: 'tabChanged', tab: 'discover' })
    expect(backToDiscover.view).toBe('search')
  })

  it('libraryChanged 更新资料库快照', () => {
    const next = appReducer(initialState, { type: 'libraryChanged', library: emptyLibrary })
    expect(next.library).toBe(emptyLibrary)
  })

  it('settingsChanged 更新设置', () => {
    const settings = settingsWith({ volume: 0.5 })
    const next = appReducer(initialState, { type: 'settingsChanged', settings })
    expect(next.settings).toEqual(settings)
  })

  it('quotaUpdated 更新免费额度', () => {
    const next = appReducer(initialState, { type: 'quotaUpdated', freeQuota: 42 })
    expect(next.freeQuota).toBe(42)
  })

  it('searchPlatformChanged 更新当前搜索平台并作废在途搜索（self invoke flag 用 seq 表达）', () => {
    const state: AppState = { ...initialState, searchPlatform: 'netease', searchSeq: 5 }
    const next = appReducer(state, { type: 'searchPlatformChanged', platform: 'qq' })
    expect(next.searchPlatform).toBe('qq')
    // 切平台 = 一次新的搜索上下文：seq 必须 +1，让在途旧请求失效（避免旧结果写进新平台槽）。
    expect(next.searchSeq).toBe(6)
  })

  it('openSearch 进入搜索页并设置初始平台', () => {
    const next = appReducer({ ...initialState, searchSeq: 5 }, { type: 'openSearch', platform: 'kugou' })
    expect(next.view).toBe('search')
    expect(next.searchPlatform).toBe('kugou')
    expect(next.searchSeq).toBe(6)
    // 搜索结果自动记忆进当前 tab，切走再切回时恢复搜索页
    expect(next.tabView.discover).toBe('search')
  })

  it('searchQueryChanged 更新当前平台槽的输入词', () => {
    const state: AppState = { ...initialState, searchPlatform: 'qq' }
    const next = appReducer(state, { type: 'searchQueryChanged', query: '晴天' })
    expect(next.search.qq.query).toBe('晴天')
  })

  it('searchStarted 不改变 searchSeq（同一平台重搜不作废在途；跨平台才由 searchPlatformChanged 作废）', () => {
    const state: AppState = { ...initialState, searchPlatform: 'netease', searchSeq: 5 }
    const next = appReducer(state, { type: 'searchStarted', query: '晴天' })
    expect(next.searchSeq).toBe(5)
  })

  it('searchStarted 写入当前搜索平台的槽并置为 loading', () => {
    const state: AppState = { ...initialState, searchPlatform: 'qq' }
    const next = appReducer(state, { type: 'searchStarted', query: '晴天' })
    expect(next.search.qq.status).toBe('loading')
    expect(next.search.qq.query).toBe('晴天')
    expect(next.search.qq.songs).toEqual([])
    expect(next.search.qq.message).toBe('正在搜索…')
    expect(next.search.qq.errorCode).toBeUndefined()
  })

  it('searchSucceeded 写入结果并保持 query', () => {
    const state: AppState = {
      ...initialState,
      searchPlatform: 'netease',
      search: {
        ...initialState.search,
        netease: { status: 'loading', query: '晴天', songs: [], message: '正在搜索…' },
      },
    }
    const next = appReducer(state, { type: 'searchSucceeded', platform: 'netease', seq: 0, songs: [song] })
    expect(next.search.netease.status).toBe('success')
    expect(next.search.netease.songs).toEqual([song])
    expect(next.search.netease.query).toBe('晴天')
    expect(next.search.netease.message).toBe('')
  })

  it('searchSucceeded 空结果时给提示文案', () => {
    const state: AppState = {
      ...initialState,
      searchPlatform: 'netease',
      search: {
        ...initialState.search,
        netease: { status: 'loading', query: '不存在的歌', songs: [], message: '正在搜索…' },
      },
    }
    const next = appReducer(state, { type: 'searchSucceeded', platform: 'netease', seq: 0, songs: [] })
    expect(next.search.netease.status).toBe('success')
    expect(next.search.netease.songs).toEqual([])
    expect(next.search.netease.message).toBe('没有找到相关歌曲，换个关键词试试')
  })

  it('searchFailed 写入错误信息保持 query', () => {
    const state: AppState = {
      ...initialState,
      searchPlatform: 'netease',
      search: {
        ...initialState.search,
        netease: { status: 'loading', query: '晴天', songs: [], message: '正在搜索…' },
      },
    }
    const next = appReducer(state, { type: 'searchFailed', platform: 'netease', seq: 0, message: '网络错误', errorCode: 'NETWORK' })
    expect(next.search.netease.status).toBe('error')
    expect(next.search.netease.songs).toEqual([])
    expect(next.search.netease.message).toBe('网络错误')
    expect(next.search.netease.query).toBe('晴天')
    expect(next.search.netease.errorCode).toBe('NETWORK')
  })

  it('各平台搜索结果槽互不影响', () => {
    const withNeteaseLoaded: AppState = {
      ...initialState,
      searchPlatform: 'netease',
      search: {
        ...initialState.search,
        netease: { status: 'success', query: '晴天', songs: [song], message: '' },
      },
    }
    const switched = appReducer(withNeteaseLoaded, { type: 'searchPlatformChanged', platform: 'qq' })
    const next = appReducer(switched, { type: 'searchStarted', query: '稻香' })
    expect(next.search.qq).toEqual({ status: 'loading', query: '稻香', songs: [], message: '正在搜索…' })
    expect(next.search.netease.status).toBe('success')
    expect(next.search.netease.songs).toEqual([song])
  })

  it('切换平台后忽略旧搜索响应', () => {
    const state: AppState = {
      ...initialState,
      searchPlatform: 'qq',
      searchSeq: 1,
      search: {
        ...initialState.search,
        qq: { status: 'loading', query: '晴天', songs: [], message: '正在搜索…' },
      },
    }
    const staleSong = { ...song, platform: 'netease' as const }
    const afterSuccess = appReducer(state, { type: 'searchSucceeded', platform: 'netease', seq: 0, songs: [staleSong] })
    const afterFailure = appReducer(state, { type: 'searchFailed', platform: 'netease', seq: 0, message: '旧请求失败', errorCode: 'NETWORK' })
    expect(afterSuccess).toBe(state)
    expect(afterFailure).toBe(state)
    expect(afterSuccess.search.qq.status).toBe('loading')
  })

  it('searchCompleted 更新指定平台槽的歌曲并广播新库', () => {
    const state: AppState = {
      ...initialState,
      searchPlatform: 'netease',
      search: {
        ...initialState.search,
        netease: { status: 'success', query: '晴天', songs: [song], message: '' },
      },
    }
    const favorited: LibrarySnapshot = { ...emptyLibrary, favorites: [song] }
    const next = appReducer(state, { type: 'searchCompleted', platform: 'netease', songs: [song], library: favorited })
    expect(next.search.netease.songs).toEqual([song])
    expect(next.search.netease.status).toBe('success')
    expect(next.library).toBe(favorited)
  })

  // ─── 歌单详情全局状态 ───

  it('openPlaylist 设置 view 与 playlistId 并保留旧详情便于切回', () => {
    const next = appReducer(initialState, { type: 'openPlaylist', playlistId: '123456789', kind: 'netease' })
    expect(next.view).toBe('playlist-detail')
    expect(next.playlistId).toBe('123456789')
    expect(next.playlistDetail.playlistId).toBe('123456789')
    expect(next.playlistDetail.kind).toBe('netease')
  })

  it('playlistDetailStarted 置 loading（加载新歌单时清空旧详情）', () => {
    const state: AppState = { ...initialState, playlistDetail: { ...initialState.playlistDetail, playlistId: '123456789', kind: 'netease' } }
    const next = appReducer(state, { type: 'playlistDetailStarted', playlistId: '123456789', kind: 'netease', requestId: 'request-1' })
    expect(next.playlistDetail.loading).toBe(true)
    expect(next.playlistDetail.error).toBe('')
    expect(next.playlistDetail.errorCode).toBeUndefined()
  })

  it('playlistDetailSucceeded 写入歌单数据', () => {
    const state: AppState = { ...initialState, playlistDetail: { ...initialState.playlistDetail, playlistId: '123456789', kind: 'netease', loading: true } }
    const playlistRef = { id: '123456789', sourceId: '123456789', name: '测试歌单', cover: '', creator: '测试用户', songCount: 1, songs: [song], updatedAt: '2026-08-17', source: 'free' as const }
    const stateWithRequest = { ...state, playlistDetail: { ...state.playlistDetail, requestId: 'request-1' } }
    const next = appReducer(stateWithRequest, { type: 'playlistDetailSucceeded', playlistId: '123456789', kind: 'netease', requestId: 'request-1', playlist: playlistRef })
    expect(next.playlistDetail.loading).toBe(false)
    expect(next.playlistDetail.error).toBe('')
    expect(next.playlistDetail.playlist).toBe(playlistRef)
  })

  it('playlistDetailFailed 写入错误信息', () => {
    const state: AppState = { ...initialState, playlistDetail: { ...initialState.playlistDetail, playlistId: '123456789', kind: 'netease', loading: true } }
    const stateWithRequest = { ...state, playlistDetail: { ...state.playlistDetail, requestId: 'request-1' } }
    const next = appReducer(stateWithRequest, { type: 'playlistDetailFailed', playlistId: '123456789', kind: 'netease', requestId: 'request-1', message: '读取失败', errorCode: 'NETWORK' })
    expect(next.playlistDetail.loading).toBe(false)
    expect(next.playlistDetail.error).toBe('读取失败')
    expect(next.playlistDetail.errorCode).toBe('NETWORK')
  })

  it('切换歌单后忽略旧详情响应', () => {
    const state: AppState = {
      ...initialState,
      playlistId: 'B',
      playlistDetail: { ...initialState.playlistDetail, playlistId: 'B', kind: 'netease', requestId: 'request-b', loading: true },
    }
    const stalePlaylist = { id: 'A', sourceId: 'A', name: '旧歌单', cover: '', creator: '用户', songCount: 0, songs: [], updatedAt: '', source: 'free' as const }
    const afterSuccess = appReducer(state, { type: 'playlistDetailSucceeded', playlistId: 'A', kind: 'netease', requestId: 'request-a', playlist: stalePlaylist })
    const afterFailure = appReducer(state, { type: 'playlistDetailFailed', playlistId: 'A', kind: 'netease', requestId: 'request-a', message: '旧请求失败', errorCode: 'NETWORK' })
    expect(afterSuccess).toBe(state)
    expect(afterFailure).toBe(state)
    expect(afterSuccess.playlistDetail.playlistId).toBe('B')
  })

  it('同一歌单刷新时忽略旧请求响应', () => {
    const started = appReducer(
      { ...initialState, playlistDetail: { ...initialState.playlistDetail, playlistId: 'A', kind: 'netease' } },
      { type: 'playlistDetailStarted', playlistId: 'A', kind: 'netease', requestId: 'request-old' },
    )
    const refreshed = appReducer(started, { type: 'playlistDetailStarted', playlistId: 'A', kind: 'netease', requestId: 'request-new' })
    const playlistRef = { id: 'A', sourceId: 'A', name: '新数据', cover: '', creator: '用户', songCount: 0, songs: [], updatedAt: '', source: 'free' as const }
    const stale = appReducer(refreshed, { type: 'playlistDetailSucceeded', playlistId: 'A', kind: 'netease', requestId: 'request-old', playlist: playlistRef })
    expect(stale).toBe(refreshed)
    const current = appReducer(refreshed, { type: 'playlistDetailSucceeded', playlistId: 'A', kind: 'netease', requestId: 'request-new', playlist: playlistRef })
    expect(current.playlistDetail.playlist).toBe(playlistRef)
  })

  it('切 tab 后歌单详情槽保留（组件卸载不影响全局状态）', () => {
    const loaded: AppState = {
      ...initialState,
      playlistDetail: {
        playlistId: '123456789',
        kind: 'netease',
        requestId: '',
        playlist: { id: '123456789', sourceId: '123456789', name: '测试歌单', cover: '', creator: '测试用户', songCount: 1, songs: [song], updatedAt: '2026-08-17', source: 'free' as const },
        loading: false,
        error: '',
      },
    }
    // 模拟用户"切到收藏 tab"再切回：只改 tab/view，不改 playlistDetail
    const switched = appReducer(loaded, { type: 'tabChanged', tab: 'favorites' })
    const back = appReducer({ ...switched, view: 'home' }, { type: 'openPlaylist', playlistId: '123456789', kind: 'netease' })
    expect(back.playlistDetail.playlist?.name).toBe('测试歌单')
  })
})

describe('导航栈', () => {
  it('openView 推入当前 tab 栈并设 view', () => {
    const s = appReducer(initialState, { type: 'openView', view: 'search' })
    expect(s.view).toBe('search')
    expect(s.nav.discover).toHaveLength(1)
    expect(s.nav.discover[0]).toEqual({ view: 'search' })
  })

  it('openView 携带歌单 ID 参数', () => {
    const s = appReducer(initialState, { type: 'openView', view: 'playlist-detail', playlistId: '123' })
    expect(s.nav.discover[0]).toEqual({ view: 'playlist-detail', playlistId: '123' })
    expect(s.playlistId).toBe('123')
  })

  it('closeView 逐级弹栈：栈顶关掉恢复上一层（设置→搜索→home）', () => {
    const opened = appReducer(initialState, { type: 'openView', view: 'search' })
    const onSettings = appReducer(opened, { type: 'openView', view: 'settings' })
    expect(onSettings.view).toBe('settings')
    const backToSearch = appReducer(onSettings, { type: 'closeView' })
    expect(backToSearch.view).toBe('search')
    expect(backToSearch.nav.discover).toHaveLength(1)
    const backToHome = appReducer(backToSearch, { type: 'closeView' })
    expect(backToHome.view).toBe('home')
    // 栈空后再次 closeView 是幂等空操作（view 不因两次关闭而异常）
    expect(backToHome.nav.discover).toHaveLength(0)
    const idleBack = appReducer(backToHome, { type: 'closeView' })
    expect(idleBack.view).toBe('home')
  })

  it('tabChanged 恢复目标 tab 栈顶视图（歌单详情切走再切回仍在详情）', () => {
    const inDetail = appReducer(initialState, { type: 'openView', view: 'playlist-detail', playlistId: '123' })
    const toFavorites = appReducer(inDetail, { type: 'tabChanged', tab: 'favorites' })
    expect(toFavorites.tab).toBe('favorites')
    expect(toFavorites.view).toBe('home')
    expect(toFavorites.nav.favorites).toHaveLength(0)
    const backToDiscover = appReducer(toFavorites, { type: 'tabChanged', tab: 'discover' })
    expect(backToDiscover.view).toBe('playlist-detail')
    expect(backToDiscover.nav.discover).toHaveLength(1)
  })

  it('hardwareBack 在二级页时逐级返回', () => {
    const opened = appReducer(initialState, { type: 'openView', view: 'settings' })
    const s = appReducer(opened, { type: 'hardwareBack' })
    expect(s.view).toBe('home')
    expect(s.nav.discover).toHaveLength(0)
    expect(s.backNeedsExit).toBe(false)
  })

  it('hardwareBack 在 home 时弹退出确认框（不直接退出，防误触）', () => {
    const toPlaylists = appReducer(initialState, { type: 'tabChanged', tab: 'playlists' })
    const s = appReducer(toPlaylists, { type: 'hardwareBack' })
    expect(s.tab).toBe('playlists')
    expect(s.view).toBe('home')
    expect(s.confirmExit).toBe(true)
    expect(s.backNeedsExit).toBe(false) // 确认前不退出
  })

  it('hardwareBack 起步即在 home（首屏）时也弹确认框', () => {
    const s = appReducer(initialState, { type: 'hardwareBack' })
    expect(s.confirmExit).toBe(true)
    expect(s.backNeedsExit).toBe(false)
  })

  it('confirmExitDismissed 关闭确认框回到原状态（返回键可再次触发）', () => {
    const s = appReducer(initialState, { type: 'hardwareBack' })
    const dismissed = appReducer(s, { type: 'confirmExitDismissed' })
    expect(dismissed.confirmExit).toBe(false)
    expect(dismissed.backNeedsExit).toBe(false)
  })

  it('confirmExitConfirmed 置 backNeedsExit 真正退出', () => {
    const s = appReducer(initialState, { type: 'hardwareBack' })
    const confirmed = appReducer(s, { type: 'confirmExitConfirmed' })
    expect(confirmed.backNeedsExit).toBe(true)
    expect(confirmed.confirmExit).toBe(false) // 确认后关闭弹窗并退出
  })

  it('返回链全流程：搜索 → 设置 → 硬返回两次（设置→搜索→home）', () => {
    const inSearch = appReducer(initialState, { type: 'openSearch', platform: 'netease' })
    expect(inSearch.nav.discover).toHaveLength(1)
    const inSettings = appReducer(inSearch, { type: 'openView', view: 'settings' })
    expect(inSettings.view).toBe('settings')
    expect(inSettings.nav.discover).toHaveLength(2)
    const back1 = appReducer(inSettings, { type: 'hardwareBack' })
    expect(back1.view).toBe('search')
    const back2 = appReducer(back1, { type: 'hardwareBack' })
    expect(back2.view).toBe('home')
    expect(back2.nav.discover).toHaveLength(0)
    // home 再按返回 → 弹确认框（不直接退出）
    const confirm = appReducer(back2, { type: 'hardwareBack' })
    expect(confirm.confirmExit).toBe(true)
    expect(confirm.backNeedsExit).toBe(false)
    // 点确认 → 真正退出
    const exit = appReducer(confirm, { type: 'confirmExitConfirmed' })
    expect(exit.backNeedsExit).toBe(true)
  })

  it('返回链全流程：歌单详情打开设置返回后恢复详情与歌单 ID', () => {
    const inDetail = appReducer(initialState, { type: 'openPlaylist', playlistId: '456', kind: 'netease' })
    const inSettings = appReducer(inDetail, { type: 'openView', view: 'settings' })
    const back = appReducer(inSettings, { type: 'closeView' })
    expect(back.view).toBe('playlist-detail')
    expect(back.playlistId).toBe('456')
  })

  it('返回链全流程：播放页从二级页进入，closeView 弹回上一级', () => {
    const inDetail = appReducer(initialState, { type: 'openPlaylist', playlistId: '1', kind: 'netease' })
    const npFromDetail = appReducer(inDetail, { type: 'openView', view: 'now-playing' })
    const backToDetail = appReducer(npFromDetail, { type: 'closeView' })
    expect(backToDetail.view).toBe('playlist-detail')
    expect(backToDetail.playlistId).toBe('1')
  })

  it('返回链全流程：歌单详情切到收藏 home 后，返回键先走栈（回详情）再 home 退出', () => {
    // 歌单 tab 打开详情
    const inDetail = appReducer(initialState, { type: 'openPlaylist', playlistId: '123', kind: 'netease' })
    expect(inDetail.tab).toBe('discover')
    // 切到收藏 tab
    const toFavorites = appReducer(inDetail, { type: 'tabChanged', tab: 'favorites' })
    expect(toFavorites.tab).toBe('favorites')
    expect(toFavorites.view).toBe('home')
    // 收藏 home 按返回：栈已切走（nav.discover 仍非空但当前 tab 是 favorites）——
    // 返回键作用于当前 tab（favorites）的栈：空 → 弹退出确认（不把用户夹带回歌单 tab）
    const confirm = appReducer(toFavorites, { type: 'hardwareBack' })
    expect(confirm.confirmExit).toBe(true)
    expect(confirm.backNeedsExit).toBe(false)
    expect(confirm.tab).toBe('favorites')
  })
})
