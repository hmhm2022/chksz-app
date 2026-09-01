import { describe, expect, it } from 'vitest'
import { extractNeteasePlaylistId, importResultMessage } from './neteaseImport'

describe('extractNeteasePlaylistId', () => {
  it('识别纯数字 ID', () => {
    expect(extractNeteasePlaylistId('5202687076')).toBe('5202687076')
    expect(extractNeteasePlaylistId('  7320483  ')).toBe('7320483')
  })

  it('识别分享链接（含 hash 路由与文本包裹）', () => {
    expect(extractNeteasePlaylistId('https://music.163.com/#/playlist?id=5202687076')).toBe('5202687076')
    expect(extractNeteasePlaylistId('https://music.163.com/playlist?id=5202687076&userid=1')).toBe('5202687076')
    expect(extractNeteasePlaylistId('分享链接：https://music.163.com/#/playlist?id=7320483')).toBe('7320483')
    expect(extractNeteasePlaylistId('music.163.com/playlist?id=7320483')).toBe('7320483')
  })

  it('非 ID / 非链接输入返回空（视为普通关键词）', () => {
    expect(extractNeteasePlaylistId('周杰伦')).toBe('')
    expect(extractNeteasePlaylistId('123')).toBe('')
    expect(extractNeteasePlaylistId('')).toBe('')
  })
})

describe('importResultMessage', () => {
  it('saved=true 提示已导入', () => {
    expect(importResultMessage('我的歌单', 30, false)).toBe('已导入「我的歌单」(30 首)')
  })

  it('existing=true 提示已存在并更新', () => {
    expect(importResultMessage('我的歌单', 30, true)).toBe('「我的歌单」已存在，已更新(30 首)')
  })

  it('空歌单与无名歌单兜底', () => {
    expect(importResultMessage('', 0, false)).toBe('已导入「该歌单」(空歌单)')
    expect(importResultMessage(null, 0, true)).toBe('「该歌单」已存在，已更新(空歌单)')
  })
})
