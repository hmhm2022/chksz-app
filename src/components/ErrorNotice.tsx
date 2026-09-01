import type { AppErrorCode } from '@shared/contracts'
import { RefreshIcon } from './icons'

interface ErrorNoticeProps {
  message: string
  /** AppError.code（可选）。用于区分「密钥无效」与「网易免费源失效」场景，决定引导文案。 */
  code?: AppErrorCode
  /** 重试按钮。 */
  onRetry?: () => void
  /** 跳设置页：密钥无效（401）/ 网易免费搜索源失效时引导切换为 ChKSz。 */
  onOpenSettings?: () => void
}

/**
 * ErrorNotice —— 统一错误提示（任务 11 错误处理统合）。
 * 按 AppError 语义自动附带可行操作：
 * - UNAUTHORIZED / 文案含"密钥无效" → 「去设置换密钥」（跳设置页）
 * - 网易免费源失效（搜索/歌单）→ 「到设置切换为 ChKSz」（跳设置页）
 * - 其余 → 可选「重试」
 * 不 blank：错误永远有文案 + 可执行动作。
 */
export function ErrorNotice({ message, code, onRetry, onOpenSettings }: ErrorNoticeProps) {
  // 网易/QQ/酷狗「歌曲搜索」走免费接口（设置里可关掉改走 ChKSz）：免费搜索源失效时引导去设置切换。
  // 免费「歌单源」没有对应的 ChKSz 开关，只给「重试」，不给误导的切换引导。
  const freeSongSourceDown = message.includes('免费网易搜索源') || message.includes('免费 QQ 搜索源') || message.includes('免费酷狗搜索源')
  const invalidKey = code === 'UNAUTHORIZED' || message.includes('密钥无效')
  const showSettings = (invalidKey || freeSongSourceDown) && onOpenSettings
  const settingsLabel = freeSongSourceDown ? '到设置切换为 ChKSz' : '去设置换密钥'
  const showActions = Boolean(showSettings || onRetry)
  return (
    <div className="error-notice" role="alert">
      <p className="error-notice-text">{message}</p>
      {showActions && (
        <div className="error-notice-actions">
          {showSettings && (
            <button type="button" className="error-notice-action primary" onClick={onOpenSettings}>
              {settingsLabel}
            </button>
          )}
          {onRetry && (
            <button type="button" className="error-notice-action" onClick={onRetry}>
              <RefreshIcon />
              重试
            </button>
          )}
        </div>
      )}
    </div>
  )
}