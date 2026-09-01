interface ExitConfirmDialogProps {
  /** 确认退出回调（触发 backNeedsExit → UI 层退出）。 */
  onConfirm: () => void
  /** 取消退出（关弹窗留在 App）。 */
  onCancel: () => void
}

/**
 * ExitConfirmDialog —— 退出确认弹窗（防误触）。
 * home 按返回键不再直接退出，先弹此框确认；点「退出」真正退出，点「取消」/遮罩/返回键取消。
 * 复用现有 confirm-overlay/confirm-box 样式（与删除确认弹窗一致）。
 */
export function ExitConfirmDialog({ onConfirm, onCancel }: ExitConfirmDialogProps) {
  return (
    <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label="退出确认">
      <div className="confirm-box confirm-box--compact">
        <h3>退出 CHKSZ Music？</h3>
        <div className="confirm-actions">
          <button type="button" className="ghost-button" onClick={onCancel}>取消</button>
          <button type="button" className="danger-button" onClick={onConfirm}>退出</button>
        </div>
      </div>
    </div>
  )
}
