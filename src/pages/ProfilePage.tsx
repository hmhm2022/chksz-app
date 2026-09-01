import { useState } from 'react'
import { useAppState } from '../app/AppState'
import { useDownloads } from '../downloads/store'
import { KeyIcon, UserIcon, DownloadIcon, HistoryIcon } from '../components/icons'

interface ProfilePageProps {
  openSettings: () => void
  openDownloads: () => void
  openHistory: () => void
}

/**
 * ProfilePage —— 我的 tab。
 * 顶部概览（额度/收藏/历史计数）+ 播放历史入口（点击进入独立页）+ 下载管理入口 + 设置入口 + 关于。
 * 额度卡点击 → 弹确认框（提醒消耗 1 次额度）→ 确认后发一笔最小真实收费请求刷新额度。
 */
export function ProfilePage({ openSettings, openDownloads, openHistory }: ProfilePageProps) {
  const { state, refreshQuota } = useAppState()
  const { tasks } = useDownloads()
  const history = state.library?.history ?? []
  const favoritesCount = state.library?.favorites.length ?? 0
  const freeQuota = state.freeQuota
  const downloadingCount = tasks.filter(task => task.status === 'downloading').length
  const [confirmRefresh, setConfirmRefresh] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')

  // 点击额度卡：先弹确认框（刷新要消耗 1 次免费额度，需用户知情）。
  const startRefresh = () => {
    if (refreshing) return
    setRefreshError('')
    setConfirmRefresh(true)
  }

  // 确认后：调 bridge 的 quota.refresh()（发一笔真实收费请求借响应头刷新额度），成功后同步到全局 state。
  const doRefresh = async () => {
    setConfirmRefresh(false)
    setRefreshing(true)
    setRefreshError('')
    try {
      await window.chksz.quota.refresh()
      await refreshQuota()
    } catch {
      setRefreshError('额度刷新失败，请稍后重试')
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <section className="profile-page">
      {/* 概览 */}
      <header className="profile-head">
        <div className="profile-avatar"><UserIcon /></div>
        <div className="profile-title">
          <h1>CHKSZ Music</h1>
          <span className="profile-version">v0.3.0 · 安卓版</span>
        </div>
      </header>
      <div className="profile-stats">
        <button type="button" className="stat quota-stat" onClick={startRefresh} disabled={refreshing} aria-label="点击刷新额度">
          <strong>{freeQuota === null ? '—' : freeQuota}</strong>
          <span>{refreshing ? '刷新中…' : '免费额度'}</span>
        </button>
        <div className="stat"><strong>{favoritesCount}</strong><span>收藏</span></div>
        <div className="stat"><strong>{history.length}</strong><span>播放记录</span></div>
      </div>
      {refreshError && <p className="form-message" role="status">{refreshError}</p>}

      {confirmRefresh && (
        <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label="刷新额度确认">
          <div className="confirm-box confirm-box--compact">
            <h3>刷新额度</h3>
            <p>刷新将消耗 1 次免费额度，确认继续？</p>
            <div className="confirm-actions">
              <button type="button" className="ghost-button" onClick={() => setConfirmRefresh(false)}>取消</button>
              <button type="button" className="primary-button" onClick={() => void doRefresh()}>确认刷新</button>
            </div>
          </div>
        </div>
      )}

      {/* 播放历史入口 */}
      <section className="profile-block">
        <button type="button" className="settings-entry" onClick={openHistory}>
          <HistoryIcon />
          <span>播放历史</span>
          {history.length > 0 && <span className="downloads-badge">{history.length}</span>}
          <span className="settings-arrow">›</span>
        </button>
      </section>

      {/* 下载管理入口 */}
      <section className="profile-block">
        <button type="button" className="settings-entry" onClick={openDownloads}>
          <DownloadIcon />
          <span>下载管理</span>
          {downloadingCount > 0 && <span className="downloads-badge">{downloadingCount}</span>}
          <span className="settings-arrow">›</span>
        </button>
      </section>

      {/* 设置入口 */}
      <section className="profile-block">
        <button type="button" className="settings-entry" onClick={openSettings}>
          <KeyIcon />
          <span>设置</span>
          <span className="settings-arrow">›</span>
        </button>
      </section>

      {/* 关于 */}
      <section className="profile-block about">
        <h2>关于</h2>
        <p>CHKSZ Music 安卓版 v0.3.0</p>
      </section>
    </section>
  )
}