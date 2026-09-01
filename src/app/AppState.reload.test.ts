import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LibrarySnapshot, Settings } from '@shared/contracts'
import type { ChkszApi } from '../bridge/types'
import { appReducer, initialState, runReload, type AppAction, type AppState } from './AppState'

const libraryFixture: LibrarySnapshot = {
  favorites: [],
  history: [],
  playlists: [],
  neteaseImports: [],
}

const settingsFixture: Settings = {
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

/** 简易 reducer harness：记录 action 序列，并实时归约出最新 state（不渲染 React 组件）。 */
function createHarness() {
  const actions: AppAction[] = []
  let state: AppState = initialState
  const dispatch = (action: AppAction) => {
    actions.push(action)
    state = appReducer(state, action)
  }
  return { get state() { return state }, actions, dispatch }
}

/** 安装 fake window.chksz（只覆盖 runReload 用到的接口，其余 cast 掉）。 */
function installFake(chksz: Record<string, unknown>): void {
  vi.stubGlobal('window', { chksz: chksz as unknown as ChkszApi })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runReload 集成', () => {
  it('有密钥且 settings/library 读取成功 → initialized(true) 带数据并刷新额度', async () => {
    const quotaGet = vi.fn(async () => 42)
    installFake({
      credentials: { hasKey: async () => true },
      settings: { get: async () => settingsFixture },
      library: { get: async () => libraryFixture },
      quota: { get: quotaGet },
    })

    const harness = createHarness()
    await runReload(harness.dispatch)

    expect(harness.state.initialized).toBe(true)
    expect(harness.state.hasKey).toBe(true)
    expect(harness.state.settings).toBe(settingsFixture)
    expect(harness.state.library).toBe(libraryFixture)
    expect(harness.state.freeQuota).toBe(42)
    expect(harness.state.initializationError).toBe('')
    expect(harness.actions.map((a) => a.type)).toEqual([
      'initializationStarted',
      'initialized',
      'quotaUpdated',
    ])
  })

  it('无密钥 → initialized(false)，不读取 settings/library/quota', async () => {
    const settingsGet = vi.fn(async () => settingsFixture)
    const libraryGet = vi.fn(async () => libraryFixture)
    const quotaGet = vi.fn(async () => 42)
    installFake({
      credentials: { hasKey: async () => false },
      settings: { get: settingsGet },
      library: { get: libraryGet },
      quota: { get: quotaGet },
    })

    const harness = createHarness()
    await runReload(harness.dispatch)

    expect(harness.state.initialized).toBe(true)
    expect(harness.state.hasKey).toBe(false)
    expect(harness.state.settings).toBeNull()
    expect(harness.state.library).toBeNull()
    expect(harness.state.freeQuota).toBeNull()
    expect(settingsGet).not.toHaveBeenCalled()
    expect(libraryGet).not.toHaveBeenCalled()
    expect(quotaGet).not.toHaveBeenCalled()
    expect(harness.actions.map((a) => a.type)).toEqual(['initializationStarted', 'initialized'])
  })

  it('settings 读取 reject → initializationFailed 并保留真实错误信息', async () => {
    const realError = new Error('模拟读取失败: QUOTA_EXCEEDED')
    const libraryGet = vi.fn(async () => libraryFixture)
    const quotaGet = vi.fn(async () => 42)
    installFake({
      credentials: { hasKey: async () => true },
      settings: {
        get: async () => {
          throw realError
        },
      },
      library: { get: libraryGet },
      quota: { get: quotaGet },
    })

    const harness = createHarness()
    await runReload(harness.dispatch)

    expect(harness.state.initialized).toBe(true)
    expect(harness.state.hasKey).toBe(false)
    expect(harness.state.initializationError).toBe(realError.message)
    // Promise.all 急切求值两个参数：settings 失败时 library 仍会被发起（结果被丢弃），
    // 但失败路径不会走到 refreshQuota，quota 不应被调用。
    expect(quotaGet).not.toHaveBeenCalled()
    expect(harness.actions.map((a) => a.type)).toEqual([
      'initializationStarted',
      'initializationFailed',
    ])
  })
})
