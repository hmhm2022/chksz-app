import type { PlaybackSource, Playlist, Song } from '../../contracts'
import { artistNames, formatFromUrl, httpsCover, seconds, songKey, text } from './helpers'
import { timeoutSignal, safeFetch } from '../compat'

/** 网易官方歌词接口（免费，不走 ChKSz 额度）。 */
const NETEASE_LYRIC_URL = 'https://music.163.com/api/song/lyric'
const LYRIC_HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://music.163.com/' }

function albumName(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'object' && value !== null && 'name' in value) return text(value.name)
  return ''
}

export function mapNeteaseSearch(payload: any): Song[] {
  // 兼容两种返回结构：新版 data 为数组，旧版 data.songs 为数组
  const raw = Array.isArray(payload?.data?.songs) ? payload.data.songs : Array.isArray(payload?.data) ? payload.data : []
  return raw.map((item: any) => {
    const id = String(item.id ?? '')
    return {
      key: songKey('netease', id),
      platform: 'netease',
      id,
      name: text(item.name, '未命名歌曲'),
      artists: artistNames(item.artists ?? item.ar),
      // album 可能是字符串（新版搜索）或对象 al.name（新版歌单 tracks）
      album: albumName(item.album ?? item.al),
      cover: httpsCover(item.picUrl ?? item.pic ?? (typeof item.album === 'object' && item.album !== null ? item.album.picUrl : undefined) ?? item.al?.picUrl),
      duration: seconds(item.duration ?? item.dt),
      qualities: []
    }
  }).filter((song: Song) => song.id)
}

export function mapNeteasePlaylist(payload: any): Playlist {
  const data = payload?.data ?? {}
  const tracks = Array.isArray(data.tracks) ? data.tracks : []
  return {
    id: String(data.id ?? ''),
    name: text(data.name, '网易歌单'),
    cover: httpsCover(data.coverImgUrl),
    creator: text(data.creator?.nickname),
    songs: mapNeteaseSearch({ data: { songs: tracks } })
  }
}

export function parseNeteasePlaylistId(input: string): string {
  const trimmed = input.trim()
  if (/^\d+$/.test(trimmed)) return trimmed
  try {
    const url = new URL(trimmed)
    const hashQuery = url.hash.includes('?') ? url.hash.slice(url.hash.indexOf('?') + 1) : ''
    const id = url.searchParams.get('id') ?? new URLSearchParams(hashQuery).get('id')
    if (id && /^\d+$/.test(id)) return id
  } catch {
    // 输入不是 URL 时交给统一的参数错误提示。
  }
  throw new Error('请输入有效的网易歌单 ID 或链接')
}

export function mapNeteasePlayback(payload: any, song: Song, quality: string): PlaybackSource {
  const data = payload?.data ?? {}
  const url = text(data.url)
  return {
    songKey: song.key,
    url,
    quality: text(data.level, quality),
    // 新版返回没有 type 字段，从 URL 后缀兜底推断格式
    format: text(data.type) || formatFromUrl(url),
    lyric: '',
    translatedLyric: ''
  }
}

/**
 * 网易云免费歌词源（官方接口 music.163.com/api/song/lyric）。
 * 返回 { lyric, translatedLyric };接口不可用/返回异常抛错,由上层按「免费歌词源不可用」提示。
 * 不耗 ChKSz 额度。测试:连续请求无限制,但延迟约 1.8-2.8s;纯音乐返回「暂无歌词」占位(非空)。
 * 注意:请求失败/解析异常才是「免费源不可用」;返回空歌词(歌没 LRC)不属于失败,由上层走「暂无歌词」。
 */
export async function fetchNeteaseLyricFree(id: string, fetcher: typeof fetch = safeFetch): Promise<{ lyric: string; translatedLyric: string }> {
  const url = `${NETEASE_LYRIC_URL}?id=${encodeURIComponent(id)}&lv=-1&kv=-1&tv=-1`
  let response: Response
  try {
    response = await fetcher(url, { headers: LYRIC_HEADERS, signal: timeoutSignal(8000) })
  } catch {
    throw new Error('免费歌词源不可用')
  }
  if (!response.ok) throw new Error('免费歌词源不可用')
  let payload: { lrc?: { lyric?: string }; tlyric?: { lyric?: string } }
  try {
    payload = await response.json() as { lrc?: { lyric?: string }; tlyric?: { lyric?: string } }
  } catch {
    throw new Error('免费歌词源不可用')
  }
  return {
    lyric: text(payload?.lrc?.lyric ?? ''),
    translatedLyric: text(payload?.tlyric?.lyric ?? '')
  }
}
