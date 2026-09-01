import { useState, type FormEvent } from 'react'
import { useAppState } from '../../app/AppState'
import { KeyIcon, LoaderIcon } from '../../components/icons'

/**
 * FirstRun —— 首次启动（无密钥或无 API 地址）引导页：
 * 输入 ChKSz API 地址和密钥，验证后进入 App 壳。
 */
export function FirstRun() {
  const { reload } = useAppState()
  const [apiBaseUrl, setApiBaseUrl] = useState('')
  const [key, setKey] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setMessage('')
    try {
      await window.chksz.testConnection(apiBaseUrl, key)
      await window.chksz.settings.update({ apiBaseUrl })
      await window.chksz.credentials.validateAndSave(key, apiBaseUrl)
      setApiBaseUrl('')
      setKey('')
      await reload()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '验证失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="first-run">
      <section className="credential-panel" aria-labelledby="setup-title">
        <div className="brand-badge">CM</div>
        <h1 id="setup-title">连接你的音乐资料库</h1>
        <p>输入 API 地址和密钥</p>
        <form onSubmit={submit}>
          <label htmlFor="api-base-url">API 地址</label>
          <input
            id="api-base-url"
            type="url"
            value={apiBaseUrl}
            onChange={(event) => setApiBaseUrl(event.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            required
          />
          <label htmlFor="api-key">API 密钥</label>
          <input
            id="api-key"
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            required
          />
          <button className="primary-button" type="submit" disabled={loading || !apiBaseUrl.trim() || !key.trim()}>
            {loading ? <LoaderIcon className="spin" /> : <KeyIcon />}
            {loading ? '验证中…' : '验证并进入'}
          </button>
        </form>
        {message && (
          <p className="form-message" role="status">
            {message}
          </p>
        )}
      </section>
    </main>
  )
}
