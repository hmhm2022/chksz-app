import { useState, type FormEvent } from 'react'
import type { LocalPlaylist, Song } from '@shared/contracts'
import { LoaderIcon } from './icons'

/** 批量加入结果：新增（已写入）与跳过（重复）数量。 */
export interface AddToPlaylistResult {
  added: number
  skipped: number
}

interface AddToPlaylistDialogProps {
  /** 整组歌曲（网易云歌单整单复制用）。 */
  songs: Song[]
  /** 来源说明（如「歌单名 · N 首」）。 */
  note: string
  playlists: LocalPlaylist[]
  /** 加入现有歌单（内部已完成 addSongs，返回写库结果）。 */
  onAdd: (playlistId: string) => Promise<AddToPlaylistResult>
  /** 新建本地歌单并整单塞入（内部已完成创建 + addSongs，返回写库结果）。 */
  onCreate: (name: string) => Promise<AddToPlaylistResult>
  onClose: () => void
}

/** 目标歌单里已存在的 key 集合，用于展示「将新增 / 将跳过」提示。 */
function countNew(playlist: LocalPlaylist, songs: Song[]): { added: number; skipped: number } {
  const existing = new Set(playlist.songs.map(song => song.key))
  return songs.reduce(
    (acc, song) => {
      if (existing.has(song.key)) acc.skipped += 1
      else acc.added += 1
      return acc
    },
    { added: 0, skipped: 0 },
  )
}

/**
 * AddToPlaylistDialog —— 「导入到本地歌单」弹层（移动版）。
 * 与桌面版 AddToPlaylistDialog 交互同形：列出本地歌单（含将新增/将跳过预览）、
 * 底部可新建歌单；点击某个目标后由父组件执行写库并提示结果。
 */
export function AddToPlaylistDialog({ songs, note, playlists, onAdd, onCreate, onClose }: AddToPlaylistDialogProps) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  // busy 存「正在操作的目标 id 或 'new'」，用于禁用按钮 + 行内加载态，未操作时为 ''。
  const multi = songs.length > 1

  const handleAdd = async (playlistId: string) => {
    if (busy) return
    setBusy(playlistId)
    setError('')
    try {
      await onAdd(playlistId)
    } catch (err) {
      // 写库失败：保留弹层与目标歌单，提示可重试，不产生 unhandled rejection。
      setError(err instanceof Error ? err.message : '添加到歌单失败，请重试')
    } finally {
      setBusy('')
    }
  }

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy('new')
    setError('')
    try {
      await onCreate(trimmed)
      setName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '新建歌单失败，请重试')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label="导入到本地歌单">
      <div className="add-to-box">
        <header className="add-to-head">
          <h3>导入到本地歌单</h3>
          <p>{note}</p>
        </header>
        <div className="add-to-choices">
          {playlists.length === 0 ? (
            <p className="list-status small">还没有本地歌单，可在下方新建</p>
          ) : (
            playlists.map(playlist => {
              const { added, skipped } = multi ? countNew(playlist, songs) : { added: 1, skipped: 0 }
              return (
                <button
                  key={playlist.id}
                  type="button"
                  className="add-to-choice"
                  onClick={() => void handleAdd(playlist.id)}
                  disabled={busy !== ''}
                >
                  <span className="add-to-name">{playlist.name}</span>
                  <span className="add-to-sub">
                    {multi
                      ? added > 0
                        ? `新增 ${added}${skipped > 0 ? ` · 跳过 ${skipped}` : ''}`
                        : '已包含全部'
                      : `${playlist.songs.length} 首`}
                  </span>
                </button>
              )
            })
          )}
        </div>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <form className="add-to-new" onSubmit={handleCreate}>
          <input
            aria-label="新歌单名称"
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="新建歌单并导入"
            disabled={busy !== ''}
          />
          <button type="submit" className="primary-button small" disabled={!name.trim() || busy !== ''}>
            {busy === 'new' ? <LoaderIcon className="spin" /> : null}
            新建
          </button>
        </form>
        <div className="add-to-actions">
          <button type="button" className="ghost-button" onClick={onClose} disabled={busy !== ''}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
