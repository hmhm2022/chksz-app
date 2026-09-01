import { AppError, type NeteasePlaylistSummary, type Playlist, type Song } from '../../contracts'
import { httpsCover } from './helpers'
import { mapNeteaseSearch } from './netease'
import { timeoutSignal, safeFetch } from '../compat'

/**
 * 网易云免费歌单发现：走官方老接口，不耗 ChKSz 额度。
 * - 精品歌单：/api/playlist/highquality/list（精选推荐）
 * - 歌单搜索：/api/search/get?type=1000（搜索发现）
 * 与 netease-search.ts（搜歌曲）共用同一套老接口，失效时抛可识别错误引导切换。
 */

const NETEASE_API = 'https://music.163.com'
const SEARCH_HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://music.163.com/' }

/** 免费网易歌单源统一错误文案。 */
function sourceError(): AppError {
  return new AppError({ code: 'NETWORK', message: '免费网易歌单源不可用，请稍后重试' })
}

function mapPlaylist(item: unknown): NeteasePlaylistSummary | null {
  if (typeof item !== 'object' || item === null) return null
  const rec = item as Record<string, unknown>
  const id = rec.id
  if (typeof id !== 'number' && typeof id !== 'string') return null
  const creator = typeof rec.creator === 'object' && rec.creator !== null ? (rec.creator as Record<string, unknown>).nickname : undefined
  return {
    id: String(id),
    name: typeof rec.name === 'string' ? rec.name.trim() : '未命名歌单',
    cover: httpsCover(typeof rec.coverImgUrl === 'string' ? rec.coverImgUrl : ''),
    creator: typeof creator === 'string' ? creator : '',
    playCount: typeof rec.playCount === 'number' ? rec.playCount : 0,
    trackCount: typeof rec.trackCount === 'number' ? rec.trackCount : 0,
    updateTime: typeof rec.updateTime === 'number' ? rec.updateTime : 0
  }
}

async function getJson(url: string, fetcher: typeof fetch): Promise<any> {
  let response: Response
  try {
    response = await fetcher(url, { headers: SEARCH_HEADERS, signal: timeoutSignal(8000) })
  } catch {
    throw sourceError()
  }
  if (!response.ok) throw sourceError()
  let payload: any
  try {
    payload = await response.json()
  } catch {
    throw sourceError()
  }
  return payload
}

/**
 * 精品歌单（精选推荐）。分类如 "全部" / "华语" / "欧美" / "粤语"。
 * 返回 { playlists, total }；total 为 0 表示分类下无精品歌单。
 */
export async function recommendNeteasePlaylistsFree(cat: string, limit: number, before: number, fetcher: typeof fetch = safeFetch): Promise<{ playlists: NeteasePlaylistSummary[]; total: number }> {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  // 网易服务端已不认 before（实测恒返回第一页），现用游标参数名为 lasttime。
  if (before > 0) params.set('lasttime', String(before))
  if (cat && cat !== '全部') params.set('cat', cat)
  const payload = await getJson(`${NETEASE_API}/api/playlist/highquality/list?${params.toString()}`, fetcher)
  const list: unknown[] = Array.isArray(payload?.playlists) ? payload.playlists : []
  return { playlists: list.map(mapPlaylist).filter((item): item is NeteasePlaylistSummary => item !== null), total: typeof payload?.total === 'number' ? payload.total : 0 }
}

/**
 * 搜索公开歌单（搜索发现）。关键词可以是歌名、歌手或歌单主题。
 * 返回 { playlists, total }：total 为命中总数（结果多于单页时用于分页），错误仍抛 sourceError()。
 */
export async function searchNeteasePlaylistsFree(keyword: string, limit: number, offset = 0, fetcher: typeof fetch = safeFetch): Promise<{ playlists: NeteasePlaylistSummary[]; total: number }> {
  const params = new URLSearchParams()
  params.set('s', keyword)
  params.set('type', '1000')
  params.set('limit', String(limit))
  if (offset > 0) params.set('offset', String(offset))
  const payload = await getJson(`${NETEASE_API}/api/search/get?${params.toString()}`, fetcher)
  const list: unknown[] = Array.isArray(payload?.result?.playlists) ? payload.result.playlists : []
  // 空结果不是接口故障（网络/HTTP 错误由 getJson 统一抛 sourceError），
  // 直接返回空，页面据此显示"没有找到相关歌单"。
  return {
    playlists: list.map(mapPlaylist).filter((item): item is NeteasePlaylistSummary => item !== null),
    // 老接口用 playlistCount 报告命中总数（约等于真实可翻页数）；无该字段时按已翻页量兜底。
    total: typeof payload?.result?.playlistCount === 'number' ? payload.result.playlistCount : offset + list.length
  }
}

/**
 * 全量公开歌单·按热度浏览（playlist/list order=hot），免费老接口。
 * ⚠️ 匿名态不带 cat（或传大类名）时 total 恒为 500~683，语义不明，
 * 因此强制要求具体细分类；分页用 offset（实测有效）。
 * 封面注意：coverImgUrl 为 http://（httpsCover 转 https），
 * 且部分带超长水印查询串易加载超时——截掉 ? 后的基础路径实测 200，映射时统一截掉。
 */
export async function hotNeteasePlaylistsFree(cat: string, limit: number, offset = 0, fetcher: typeof fetch = safeFetch): Promise<{ playlists: NeteasePlaylistSummary[]; total: number }> {
  if (!cat || cat === '全部') throw sourceError()
  const params = new URLSearchParams()
  params.set('order', 'hot')
  params.set('cat', cat)
  params.set('limit', String(limit))
  if (offset > 0) params.set('offset', String(offset))
  const payload = await getJson(`${NETEASE_API}/api/playlist/list?${params.toString()}`, fetcher)
  const list: unknown[] = Array.isArray(payload?.playlists) ? payload.playlists : []
  return {
    playlists: list.map(mapPlaylist).filter((item): item is NeteasePlaylistSummary => item !== null)
      // 水印查询串截断：?imageView=...&watermark... 超长且 CDN 偶发超时，基础路径即可出图。
      .map(item => ({ ...item, cover: item.cover.split('?')[0] })),
    total: typeof payload?.total === 'number' ? payload.total : 0
  }
}

/**
 * 个性化推荐歌单（App 首页"推荐歌单"同源），免费免登录。
 * feed 性质：每次请求内容不同、最多约 30 条、无分页无分类；
 * 字段差异：封面是 picUrl，无 creator。
 */
export async function personalizedPlaylistsFree(limit: number, fetcher: typeof fetch = safeFetch): Promise<NeteasePlaylistSummary[]> {
  const payload = await getJson(`${NETEASE_API}/api/personalized/playlist?limit=${limit}`, fetcher)
  const list: unknown[] = Array.isArray(payload?.result) ? payload.result : []
  return list.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) return null
    const rec = item as Record<string, unknown>
    const id = rec.id
    if (typeof id !== 'number' && typeof id !== 'string') return null
    return {
      id: String(id),
      name: typeof rec.name === 'string' ? rec.name.trim() : '未命名歌单',
      cover: httpsCover(typeof rec.picUrl === 'string' ? rec.picUrl : ''),
      creator: '',
      playCount: typeof rec.playCount === 'number' ? rec.playCount : 0,
      trackCount: typeof rec.trackCount === 'number' ? rec.trackCount : 0,
      updateTime: typeof rec.trackNumberUpdateTime === 'number' ? rec.trackNumberUpdateTime : 0
    } satisfies NeteasePlaylistSummary
  }).filter((item): item is NeteasePlaylistSummary => item !== null)
}

/** 官方榜单摘要（toplist）。榜 ID 可直接当歌单打开（fetchNeteasePlaylistFree(id)）。 */
export interface ToplistSummary { id: string; name: string; cover: string }

/** 官方音乐榜单列表（飙升/新歌/热歌/曲风榜…共 60+ 个），免费免登录。 */
export async function neteaseToplistsFree(fetcher: typeof fetch = safeFetch): Promise<ToplistSummary[]> {
  const payload = await getJson(`${NETEASE_API}/api/toplist`, fetcher)
  const list: unknown[] = Array.isArray(payload?.list) ? payload.list : []
  return list.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) return null
    const rec = item as Record<string, unknown>
    const id = rec.id
    if (typeof id !== 'number' && typeof id !== 'string') return null
    return {
      id: String(id),
      name: typeof rec.name === 'string' ? rec.name.trim() : '未命名榜单',
      cover: httpsCover(typeof rec.coverImgUrl === 'string' ? rec.coverImgUrl : '')
    } satisfies ToplistSummary
  }).filter((item): item is ToplistSummary => item !== null)
}

/** song/detail 批量查询的粒度（每批 id 数）。 */
const DETAIL_BATCH = 100

/**
 * 免费拉取完整歌单（含歌曲时长），交替命中 v3 与 song/detail，不耗 ChKSz 额度。
 * - v3/playlist/detail 返回全部歌曲 id（trackIds）+ 歌单元信息
 * - song/detail?ids=[...] 按 id 批量返回歌曲详情（含 duration 时长、封面、歌手）
 * 两个接口都免费。任一步骤失败抛可识别错误。
 */
export async function fetchNeteasePlaylistFree(id: string, fetcher: typeof fetch = safeFetch): Promise<Playlist> {
  // 1. v3 歌单详情：拿元信息 + 完整 trackIds
  const detail = await getJson(`${NETEASE_API}/api/v3/playlist/detail?id=${encodeURIComponent(id)}`, fetcher)
  const pl = detail?.playlist
  if (!pl || typeof pl !== 'object') throw sourceError()
  const trackIds: unknown[] = Array.isArray(pl.trackIds) ? pl.trackIds : []
  const ids = Array.from(new Set(trackIds.map((t: any) => t?.id).filter((x: unknown): x is number => typeof x === 'number')))
  if (ids.length === 0) throw sourceError()

  // 2. song/detail 分批补全歌曲详情（含时长）
  const songs: Song[] = []
  for (let i = 0; i < ids.length; i += DETAIL_BATCH) {
    const batch = ids.slice(i, i + DETAIL_BATCH)
    const idsJson = '[' + batch.join(',') + ']'
    const payload = await getJson(`${NETEASE_API}/api/song/detail?ids=${encodeURIComponent(idsJson)}`, fetcher)
    const raw: unknown[] = Array.isArray(payload?.songs) ? payload.songs : []
    if (raw.length === 0) throw sourceError()
    // song/detail 封面为 http，统一转 https 以满足客户端安全策略。
    songs.push(...mapNeteaseSearch({ data: { songs: raw } }).map(song => ({ ...song, cover: httpsCover(song.cover) })))
  }

  const creator = typeof pl.creator === 'object' && pl.creator !== null ? (pl.creator as Record<string, unknown>).nickname : undefined
  return {
    id,
    name: typeof pl.name === 'string' ? pl.name.trim() : '网易歌单',
    cover: httpsCover(typeof pl.coverImgUrl === 'string' ? pl.coverImgUrl : ''),
    creator: typeof creator === 'string' ? creator : '',
    songs
  }
}
