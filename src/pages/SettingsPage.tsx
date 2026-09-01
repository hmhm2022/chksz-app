import { useState } from 'react'
import type { MusicPlatform, Settings } from '@shared/contracts'
import { useAppState } from '../app/AppState'
import { kugouQualityOptions, neteaseQualityOptions, qqQualityOptions } from '../player/quality'
import { BackIcon, KeyIcon, LoaderIcon } from '../components/icons'

interface SettingsPageProps {
  onBack: () => void
}

/**
 * SettingsPage —— 设置页。
 * 默认平台、各平台音质、循环模式、网易免费搜索开关、更换 API 密钥。
 * （音量调节在播放页提供，此处不保留重复入口。）
 */
export function SettingsPage({ onBack }: SettingsPageProps) {
  const { state, dispatch, reload } = useAppState()
  const current = state.settings
  const [key, setKey] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [apiBaseUrlDraft, setApiBaseUrlDraft] = useState<string>(current?.apiBaseUrl ?? '')
  const [testing, setTesting] = useState(false)
  const [testMessage, setTestMessage] = useState('')
  // 每日额度本地草稿：输入框受控于此，打字不直接改全局（避免非法中间态被守卫拦回、退格删不掉首位）。
  const [dailyQuotaDraft, setDailyQuotaDraft] = useState<string>(String(current?.dailyQuota ?? ''))
  if (!current) return null

  const update = async (patch: Partial<Settings>) => {
    try {
      const settings = await window.chksz.settings.update(patch)
      dispatch({ type: 'settingsChanged', settings })
      setMessage('设置已保存')
    } catch {
      setMessage('设置保存失败')
    }
  }

  const saveKey = async () => {
    setSaving(true)
    setMessage('正在验证密钥…')
    try {
      await window.chksz.credentials.validateAndSave(key)
      setKey('')
      await reload()
      setMessage('密钥已更新')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '密钥验证失败')
    } finally {
      setSaving(false)
    }
  }

  const testConnection = async () => {
    setTesting(true)
    setTestMessage('正在测试连接…')
    try {
      // 如果用户输入了新密钥，使用新密钥；否则提示用户输入密钥
      const keyToTest = key.trim()
      if (!keyToTest) {
        throw new Error('请输入 API 密钥')
      }
      await window.chksz.testConnection(apiBaseUrlDraft, keyToTest)
      setTestMessage('连接成功 ✓')
    } catch (error) {
      setTestMessage(error instanceof Error ? error.message : '连接测试失败')
    } finally {
      setTesting(false)
    }
  }

  return (
    <section className="settings-page">
      <div className="page-topbar">
        <button className="icon-btn" type="button" onClick={onBack} aria-label="返回">
          <BackIcon />
        </button>
        <h1 className="page-topbar-title">设置</h1>
        <span className="page-topbar-spacer" aria-hidden="true" />
      </div>

      <section className="settings-block">
        <h2>连接</h2>
        <label htmlFor="api-base-url">API 地址</label>
        <input
          id="api-base-url"
          type="url"
          value={apiBaseUrlDraft}
          onChange={event => setApiBaseUrlDraft(event.target.value)}
          onBlur={() => {
            if (apiBaseUrlDraft !== current.apiBaseUrl) {
              void update({ apiBaseUrl: apiBaseUrlDraft })
            }
          }}
          placeholder="输入 API 地址"
        />
        
        <label htmlFor="replace-key">更换 API 密钥</label>
        <div className="key-row">
          <KeyIcon />
          <input id="replace-key" type="password" value={key} onChange={event => setKey(event.target.value)} placeholder="输入新的 chksz_ 密钥" autoComplete="off" />
          <button className="primary-button small" type="button" onClick={() => void saveKey()} disabled={saving || !key.trim()}>
            {saving ? <LoaderIcon className="spin" /> : <span>保存</span>}
          </button>
        </div>
        
        <button className="primary-button small" type="button" onClick={() => void testConnection()} disabled={testing || !apiBaseUrlDraft.trim()}>
          {testing ? <LoaderIcon className="spin" /> : <span>测试连接</span>}
        </button>
        {testMessage && <p className="form-message" role="status">{testMessage}</p>}
      </section>

      <section className="settings-block">
        <h2>播放</h2>
        <label htmlFor="default-platform">默认平台</label>
        <select id="default-platform" value={current.defaultPlatform} onChange={event => void update({ defaultPlatform: event.target.value as MusicPlatform })}>
          <option value="netease">网易云</option>
          <option value="qq">QQ 音乐</option>
          <option value="kugou">酷狗</option>
        </select>

        <label htmlFor="netease-quality">网易音质</label>
        <select id="netease-quality" value={current.neteaseQuality} onChange={event => void update({ neteaseQuality: event.target.value })}>
          {neteaseQualityOptions().map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>

        <label htmlFor="qq-quality">QQ 音质</label>
        <select id="qq-quality" value={current.qqQuality} onChange={event => void update({ qqQuality: event.target.value })}>
          {qqQualityOptions().map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>

        <label htmlFor="kugou-quality">酷狗音质</label>
        <select id="kugou-quality" value={current.kugouQuality} onChange={event => void update({ kugouQuality: event.target.value })}>
          {kugouQualityOptions().map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>

        <label htmlFor="repeat-mode">循环模式</label>
        <select id="repeat-mode" value={current.repeatMode} onChange={event => void update({ repeatMode: event.target.value as Settings['repeatMode'] })}>
          <option value="sequence">顺序播放</option>
          <option value="list">列表循环</option>
          <option value="one">单曲循环</option>
          <option value="shuffle">随机播放</option>
        </select>

        <label htmlFor="daily-quota">每日额度</label>
        <input
          id="daily-quota"
          type="number"
          min={1}
          step={1}
          value={dailyQuotaDraft}
          onChange={event => {
            // 打字只更新草稿，绝不写回设置：中间态（空串/0/逐位删除）不污染真实值。
            setDailyQuotaDraft(event.target.value)
          }}
          onBlur={() => {
            // 失焦一次性决定：草稿合法且不同于已保存值 → 保存；否则（空/非法/未变）回弹到已保存值。
            const num = Number(dailyQuotaDraft)
            const valid = dailyQuotaDraft !== '' && Number.isFinite(num) && num >= 1
            if (valid && Math.round(num) !== current.dailyQuota) {
              void update({ dailyQuota: Math.round(num) })
              setDailyQuotaDraft(String(Math.round(num)))
            } else {
              setDailyQuotaDraft(String(current.dailyQuota))
            }
          }}
          aria-label="每日额度"
        />

        <label className="check-row" htmlFor="netease-free-search">
          <input id="netease-free-search" type="checkbox" checked={current.neteaseSearchFree} onChange={event => void update({ neteaseSearchFree: event.target.checked })} />
          启用免费网易搜索源（不耗额度）
        </label>

        <label className="check-row" htmlFor="qq-free-search">
          <input id="qq-free-search" type="checkbox" checked={current.qqSearchFree} onChange={event => void update({ qqSearchFree: event.target.checked })} />
          启用免费 QQ 搜索源（不耗额度）
        </label>

        <label className="check-row" htmlFor="kugou-free-search">
          <input id="kugou-free-search" type="checkbox" checked={current.kugouSearchFree} onChange={event => void update({ kugouSearchFree: event.target.checked })} />
          启用免费酷狗搜索源（不耗额度）
        </label>
      </section>

      {message && <p className="form-message" role="status">{message}</p>}
    </section>
  )
}
