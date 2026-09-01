import { useDownloads, type DownloadTask } from '../downloads/store'
import { BackIcon, LoaderIcon, RefreshIcon } from '../components/icons'
import type { Song } from '@shared/contracts'

interface DownloadsPageProps {
  onBack: () => void
}

/** 平台字占位（与 SongListItem 一致）。 */
const COVER_FALLBACK: Record<Song['platform'], string> = { netease: '云', qq: 'Q', kugou: 'K' }

/** 字节 → 人类可读（KB/MB，1 位小数）。 */
const humanSize = (bytes: number): string => {
  if (!bytes || bytes <= 0) return '--'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * DownloadsPage —— 下载管理页（Task 11）。
 * 三块列表：
 * - 进行中：封面 + 歌名/歌手 + 进度条（% + 已下载/总量，总量未知只显已下载）
 * - 已完成（内存刚完成的简短态 + 持久化历史）：「已保存到下载」标签 + 大小
 * - 失败：错误信息 + 重试（新 taskId 重新走完整下载链路）
 * 空态：「还没有下载记录」。
 */
export function DownloadsPage({ onBack }: DownloadsPageProps) {
  const { tasks, history, downloadedKeys, loaded, retryTask } = useDownloads()
  // 进行中 + 失败（error 保留允许重试；done 归到历史，不做重复展示）。
  const active = tasks.filter(task => task.status !== 'done')
  const doneInMemory = tasks.filter(task => task.status === 'done')

  const renderIcon = (platform: Song['platform']) =>
    <span className={`cover-fallback ${platform}`}>{COVER_FALLBACK[platform]}</span>

  return (
    <section className="downloads-page">
      <header className="page-topbar">
        <button className="icon-btn" type="button" onClick={onBack} aria-label="返回">
          <BackIcon />
        </button>
        <h1 className="page-topbar-title">下载管理</h1>
        <span className="page-topbar-spacer" />
      </header>

      {!loaded ? (
        <div className="list-status">
          <LoaderIcon className="spin" />
          正在读取下载记录
        </div>
      ) : active.length === 0 && history.length === 0 && doneInMemory.length === 0 ? (
        <div className="list-status">还没有下载记录</div>
      ) : (
        <div className="downloads-body">
          {active.length > 0 && (
            <section className="downloads-section">
              <h2 className="downloads-heading">进行中 / 失败</h2>
              <ul className="download-list">
                {active.map(task => <ActiveRow key={task.taskId} task={task} onRetry={() => void retryTask(task)} />)}
              </ul>
            </section>
          )}

          {(doneInMemory.length > 0 || history.length > 0) && (
            <section className="downloads-section">
              <h2 className="downloads-heading">已下载</h2>
              <ul className="download-list">
                {doneInMemory.map(task => {
                  const record = history.find(item => item.taskId === task.taskId)
                  return <DoneRow key={task.taskId} task={task} size={record?.size ?? task.downloaded} />
                })}
                {history.map(record => {
                  // 内存 done 任务已在上面渲染；历史里其他记录（含跨启动）在此渲染。
                  if (doneInMemory.some(task => task.taskId === record.taskId)) return null
                  return (
                    <li key={record.taskId} className="download-row">
                      <span className="download-cover">
                        {record.song.cover ? <img src={record.song.cover} alt="" loading="lazy" /> : renderIcon(record.song.platform)}
                      </span>
                      <div className="download-meta">
                        <strong className="download-name">{record.song.name}</strong>
                        <span className="download-artist">{record.song.artists.join(' / ') || '未知歌手'}</span>
                      </div>
                      <span className="download-side">
                        <span className="download-tag">已保存到下载</span>
                        <span className="download-size">{humanSize(record.size)}</span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
        </div>
      )}

      {downloadedKeys.size > 0 && (
        <p className="downloads-hint">下载的文件已保存到系统「下载」目录，可在文件管理器中查看</p>
      )}
    </section>
  )
}

/** 进行中 / 失败行。 */
function ActiveRow({ task, onRetry }: { task: DownloadTask; onRetry: () => void }) {
  const percent = task.total > 0 ? Math.min(100, task.progress) : task.downloaded > 0 ? 0 : 0
  return (
    <li className="download-row">
      <span className="download-cover">
        {task.song.cover ? <img src={task.song.cover} alt="" loading="lazy" /> : (() => {
          const fallback: Record<Song['platform'], string> = { netease: '云', qq: 'Q', kugou: 'K' }
          return <span className={`cover-fallback ${task.song.platform}`}>{fallback[task.song.platform]}</span>
        })()}
      </span>
      <div className="download-meta">
        <strong className="download-name">{task.song.name}</strong>
        <span className="download-artist">{task.song.artists.join(' / ') || '未知歌手'}</span>
        {task.status === 'error' ? (
          <span className="download-error">{task.message ?? '下载失败，请重试'}</span>
        ) : (
          <span className="download-progress">
            <span className="progress-bar">
              <span className="progress-fill" style={{ width: `${percent}%` }} />
            </span>
            <span className="progress-text">
              {task.total > 0 ? `${Math.round(percent)}%` : ''} {humanSize(task.downloaded)}
              {task.total > 0 ? ` / ${humanSize(task.total)}` : ''}
            </span>
          </span>
        )}
      </div>
      {task.status === 'error' && (
        <button type="button" className="download-retry" onClick={onRetry} aria-label={`重试下载 ${task.song.name}`}>
          <RefreshIcon />
          重试
        </button>
      )}
    </li>
  )
}

/** 已完成（内存）行：与历史共用样式，展示大小 + 标签。 */
function DoneRow({ task, size }: { task: DownloadTask; size: number }) {
  return (
    <li className="download-row">
      <span className="download-cover">
        {task.song.cover ? <img src={task.song.cover} alt="" loading="lazy" /> : (() => {
          const fallback: Record<Song['platform'], string> = { netease: '云', qq: 'Q', kugou: 'K' }
          return <span className={`cover-fallback ${task.song.platform}`}>{fallback[task.song.platform]}</span>
        })()}
      </span>
      <div className="download-meta">
        <strong className="download-name">{task.song.name}</strong>
        <span className="download-artist">{task.song.artists.join(' / ') || '未知歌手'}</span>
      </div>
      <span className="download-side">
        <span className="download-tag">已保存到下载</span>
        <span className="download-size">{humanSize(size)}</span>
      </span>
    </li>
  )
}