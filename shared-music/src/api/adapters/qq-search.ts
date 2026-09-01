import type { Song } from '../../contracts'
import { artistNames, songKey, text } from './helpers'
import { timeoutSignal, safeFetch } from '../compat'

/**
 * QQ 搜索走免费官方老接口 c.y.qq.com，不走 ChKSz 额度。
 * 返回的搜索项直接带 封面(albummid 拼图)、时长(interval)、播放用 mid(songmid)。
 * 实测：按关键词返回 5 首全成功，零限流。
 */

const QQ_SEARCH_URL = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp'
const QQ_COVER_CDN = (albumMid: string) => `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`
const SEARCH_HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://y.qq.com/' }

interface QqSearchResponse {
  data?: {
    song?: {
      list?: unknown[]
    }
  }
}

function mapItem(item: unknown): Song | null {
  if (typeof item !== 'object' || item === null) return null
  const rec = item as Record<string, unknown>
  const mid = text(rec.songmid)
  if (!mid) return null
  const singers = Array.isArray(rec.singer)
    ? rec.singer.map((s: unknown) => (typeof s === 'object' && s !== null ? text((s as Record<string, unknown>).name) : '')).filter(Boolean)
    : []
  return {
    key: songKey('qq', mid),
    platform: 'qq',
    id: mid,
    name: text(rec.songname, '未命名歌曲'),
    artists: singers.length ? singers : artistNames(rec.singer),
    album: text(rec.albumname),
    cover: text(rec.albummid) ? QQ_COVER_CDN(text(rec.albummid)) : '',
    duration: typeof rec.interval === 'number' ? rec.interval : null,
    qualities: []
  }
}

/** 免费搜索 QQ：关键词 → 歌曲列表（含封面+时长）。请求失败返回 null，成功无结果返回空数组。 */
export async function searchQqFree(keyword: string, fetcher: typeof fetch = safeFetch): Promise<Song[] | null> {
  try {
    const url = `${QQ_SEARCH_URL}?p=1&n=20&w=${encodeURIComponent(keyword)}&format=json`
    const response = await fetcher(url, { headers: SEARCH_HEADERS, signal: timeoutSignal(8000) })
    if (!response.ok) return null
    const payload = await response.json() as QqSearchResponse
    const list = payload?.data?.song?.list ?? []
    if (list.length === 0) return []
    return list.map(mapItem).filter((song): song is Song => song !== null)
  } catch {
    return null
  }
}
