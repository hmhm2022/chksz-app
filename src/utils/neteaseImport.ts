/**
 * 网易歌单输入识别与导入反馈文案。
 * 刻意做成纯函数便于测试；不依赖 window.chksz。
 */

/** 从输入识别歌单：纯数字 ID 或分享链接返回 ID，否则返回空（当作普通关键词）。 */
export function extractNeteasePlaylistId(input: string): string {
  const trimmed = input.trim()
  if (/^\d{5,}$/.test(trimmed)) return trimmed
  // 兼容分享文案里的链接：music.163.com/#/playlist?id=xxx 或 /playlist?id=xxx
  const m = trimmed.match(/playlist\?id=(\d{5,})/)
  if (m?.[1]) return m[1]
  return ''
}

/**
 * 导入结果提示。
 * existing=true 表示该歌单此前已导入过（本地已有快照，本次刷新）；否则是全新导入。
 * 注意：共享层 importNeteasePlaylist 返回的 saved 恒为 true（移动端 importStore 恒存在），
 * 无法区分首导/更新，故由调用方用导入前最近导入列表判断 existing。
 */
export function importResultMessage(name: string | null, songCount: number, existing: boolean): string {
  const count = songCount > 0 ? `${songCount} 首` : '空歌单'
  const label = name || '该歌单'
  return existing ? `「${label}」已存在，已更新(${count})` : `已导入「${label}」(${count})`
}
