import { AppError } from '../../contracts'
import type { Song } from '../../contracts'
import { artistNames, seconds, songKey, text } from './helpers'
import { timeoutSignal, safeFetch } from '../compat'

/**
 * 网易云免费搜索：走官方老接口 music.163.com/api/search/get。
 * 搜索返回嵌套结构（artists 数组、album 对象、duration 毫秒），不含专辑封面；
 * 封面用 song/detail 接口（免费）按 id 补全 album.picUrl。
 * 实测两者均无 UA 限制、连续请求全成功；但为未公开接口，失效时抛可识别错误让上层提示切换。
 */

const NETEASE_SEARCH_URL = 'https://music.163.com/api/search/get'
const NETEASE_DETAIL_URL = 'https://music.163.com/api/song/detail'
const SEARCH_HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://music.163.com/' }

function mapItem(item: unknown): Song | null {
  if (typeof item !== 'object' || item === null) return null
  const rec = item as Record<string, unknown>
  const id = rec.id
  if (typeof id !== 'number') return null
  return {
    key: songKey('netease', String(id)),
    platform: 'netease',
    id: String(id),
    name: text(rec.name, '未命名歌曲'),
    artists: artistNames(rec.artists),
    album: text(typeof rec.album === 'object' && rec.album !== null ? (rec.album as Record<string, unknown>).name : undefined),
    cover: '',
    duration: seconds(rec.duration),
    qualities: []
  }
}

/** 单首：song/detail 拿专辑封面 picUrl；失败返回空。 */
async function coverFromDetail(id: string, fetcher: typeof fetch): Promise<string> {
  try {
    const url = `${NETEASE_DETAIL_URL}?ids=[${id}]`
    const response = await fetcher(url, { headers: SEARCH_HEADERS, signal: timeoutSignal(8000) })
    if (!response.ok) return ''
    const payload = await response.json() as { songs?: Array<{ album?: { picUrl?: string } }> }
    return payload?.songs?.[0]?.album?.picUrl ?? ''
  } catch {
    return ''
  }
}

/** 免费搜索网易云（老接口）。接口失效抛 AppError，成功无结果返回空数组。 */
export async function searchNeteaseFree(keyword: string, fetcher: typeof fetch = safeFetch): Promise<Song[]> {
  let response: Response
  try {
    const url = `${NETEASE_SEARCH_URL}?type=1&s=${encodeURIComponent(keyword)}&limit=20`
    response = await fetcher(url, { headers: SEARCH_HEADERS, signal: timeoutSignal(8000) })
  } catch {
    throw new AppError({ code: 'NETWORK', message: '免费网易搜索源不可用，请到设置切换为 ChKSz 或稍后重试' })
  }
  if (!response.ok) {
    throw new AppError({ code: 'NETWORK', message: '免费网易搜索源不可用，请到设置切换为 ChKSz 或稍后重试' })
  }
  let payload: { result?: { songs?: unknown[] } }
  try {
    payload = await response.json() as { result?: { songs?: unknown[] } }
  } catch {
    throw new AppError({ code: 'NETWORK', message: '免费网易搜索源返回异常，请到设置切换为 ChKSz 或稍后重试' })
  }
  const rawSongs = payload?.result?.songs ?? []
  if (rawSongs.length === 0) {
    return []
  }
  const songs = rawSongs.map(mapItem).filter((song): song is Song => song !== null)
  // 并行按 id 补专辑封面（免费接口，失败保留空走占位图）。
  const covers = await Promise.all(songs.map(song => coverFromDetail(song.id, fetcher)))
  return songs.map((song, index) => (covers[index] ? { ...song, cover: covers[index] } : song))
}
