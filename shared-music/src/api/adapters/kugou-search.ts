import type { Song } from '../../contracts'
import { httpsCover, songKey, text } from './helpers'
import { timeoutSignal, safeFetch } from '../compat'

/**
 * 酷狗搜索走免费非官方 v3 接口，不走 ChKSz 额度。
 * 返回的搜索项直接带 封面(union_cover 模板)、时长(duration)、播放用 id(hash)。
 * 实测：按关键词返回 20 首全成功，零限流。
 */

const KUGOU_SEARCH_URL = 'https://mobiles.kugou.com/api/v3/search/song?format=json'
const V3_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' }

interface KugouSearchResponse {
  data?: { info?: unknown[] }
}

function mapItem(item: unknown): Song | null {
  if (typeof item !== 'object' || item === null) return null
  const rec = item as Record<string, unknown>
  const id = text(rec.hash)
  if (!id) return null
  const trans = rec.trans_param
  let cover = ''
  if (typeof trans === 'object' && trans !== null) {
    const template = text((trans as Record<string, unknown>).union_cover)
    // union_cover 模板是 http://（如 http://imge.kugou.com/stdmusic/{size}/...），
    // 真机 WebView 会被 Android 明文流量策略拦截（Cleartext HTTP not permitted）→ httpsCover 统一转 https。
    if (template.includes('{size}')) cover = httpsCover(template.replace('{size}', '400'))
  }
  return {
    key: songKey('kugou', id),
    platform: 'kugou',
    id,
    name: text(rec.songname, '未命名歌曲'),
    artists: [text(rec.singername)].filter(Boolean),
    album: text(rec.album_name),
    cover,
    duration: typeof rec.duration === 'number' ? rec.duration : null,
    qualities: []
  }
}

/** 免费搜索酷狗：关键词 → 歌曲列表（含封面+时长）。请求失败返回 null，成功无结果返回空数组。 */
export async function searchKugouFree(keyword: string, fetcher: typeof fetch = safeFetch): Promise<Song[] | null> {
  try {
    const url = `${KUGOU_SEARCH_URL}&keyword=${encodeURIComponent(keyword)}&page=1&pagesize=20`
    const response = await fetcher(url, { headers: V3_HEADERS, signal: timeoutSignal(8000) })
    if (!response.ok) return null
    const payload = await response.json() as KugouSearchResponse
    const list = payload?.data?.info ?? []
    if (list.length === 0) return []
    return list.map(mapItem).filter((song): song is Song => song !== null)
  } catch {
    return null
  }
}
