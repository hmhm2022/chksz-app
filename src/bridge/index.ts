import { MusicService } from '@shared/api/music-service'
import { ChkszClient } from '@shared/api/client'
import { RequestQueue } from '@shared/api/request-queue'
import { LibraryStore } from '@shared/storage/library-store'
import { SettingsStore } from '@shared/storage/settings-store'
import { QuotaStore } from '@shared/storage/quota-store'
import { DownloadsStore } from '@shared/storage/downloads-store'
import { CredentialStore } from '@shared/storage/credentials'
import { MusicDB } from '@shared/storage/db'
import { safeFetch } from '@shared/api/compat'
import { AppError } from '@shared/contracts'
import { playerBridge } from '../playerBridge'
import { systemBridge } from '../systemBridge'
import type { ChkszApi } from './types'

/** 验证密钥时用的一次性查询（与桌面版 validateAndSave 语义一致）。 */
const VALIDATE_PATH = '/api/163_search'
const VALIDATE_PARAMS = { keyword: '晴天', limit: 1 }

/** 平台白名单，与桌面版 IPC 一致（register.ts）。 */
const SEARCH_PLATFORMS = ['netease', 'qq', 'kugou'] as const

/** 可信任的音频扩展名白名单（与桌面版 file-name.ts 的 audioFormat 一致）。 */
const ALLOWED_AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'flac', 'ogg', 'wav'])

/** 从 format/url 推断下载扩展名：白名单内的 format 优先，其次 url 后缀，兜底 mp3。 */
function inferAudioExt(format: string | null, url: string): string {
  const fromFormat = format?.toLowerCase().replace(/^\./, '') ?? ''
  if (ALLOWED_AUDIO_EXTS.has(fromFormat)) return fromFormat
  const suffix = url.split('?')[0]?.split('.').pop()?.toLowerCase() ?? ''
  if (ALLOWED_AUDIO_EXTS.has(suffix)) return suffix
  return 'mp3'
}

/** 本地日期键（YYYY-MM-DD）。额度每日重置，跨日判断用它比对记录日期。 */
function todayKey(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 组装 window.chksz 全局桥接对象（桌面版 DesktopApi 同形 + player 原生播放桥）。
 *
 * 在 App 渲染前调用（见 main.tsx），保证 UI 组件首次读取 window.chksz 时就绪。
 * 防重入：重复调用直接返回，保持幂等（HMR / 重复挂载安全）。
 */
export function setupChkszBridge(): void {
  if (window.chksz) return

  const credentials = new CredentialStore()
  const queue = new RequestQueue()
  // 两个存储层共享同一个 MusicDB 实例，避免将来数据分叉。
  const db = new MusicDB()
  const library = new LibraryStore(db)
  const settings = new SettingsStore(db)
  const downloads = new DownloadsStore(db)
  const quota = new QuotaStore(db)
  // 从设置中读取 apiBaseUrl；没有用户地址时保持空值，禁止 Chksz 请求。
  const client = new ChkszClient({
    getKey: () => credentials.getKey(),
    queue,
    baseUrl: '',
    onQuota: (freeQuota) => void quota.set({ freeQuota, date: todayKey() }),
  })

  const applyBaseUrl = (baseUrl: string) => {
    client.setBaseUrl(baseUrl)
    void playerBridge.setBaseUrl(baseUrl).catch(() => {})
  }

  settings.get().then(s => {
    applyBaseUrl(s.apiBaseUrl)
  })
  // LibraryStore 实现 MusicService 需要的 NeteaseImportStore 接口（save/update/get/getImports），直接传入。
  // fetcher 必须用 safeFetch（经 globalThis.fetch 调用）而非裸 fetch：后者在部分 WebView 上会因
  // this 绑定丢失抛 Illegal invocation（详见 compat.ts 注释），免费搜索适配器都会走这个 fetcher。
  const music = new MusicService(client, safeFetch, library)

  window.chksz = {
    credentials: {
      hasKey: () => credentials.hasKey(),
      // 语义与桌面版一致：先 trim，再用该 key 建临时 client 走一次真实查询；
      // 成功才落库，失败（密钥无效 / 网络错误 / 超时）原样抛给上层提示。
      // 地址必须由调用方传入：FirstRun 会先测试该地址，此处再用同一地址校验密钥。
      validateAndSave: async (key: string, baseUrl?: string) => {
        const normalizedKey = key.trim()
        if (!normalizedKey) throw new Error('请输入 API 密钥')
        // 格式前缀快速失败（与 CredentialStore.setKey 同一约定），省一次无谓网络请求。
        if (!normalizedKey.startsWith('chksz_')) throw new Error('密钥格式不正确')
        const normalizedBaseUrl = baseUrl?.trim() ?? ''
        if (!normalizedBaseUrl) throw new Error('请输入 API 地址')
        const candidate = new ChkszClient({ getKey: async () => normalizedKey, queue, baseUrl: normalizedBaseUrl })
        await candidate.get(VALIDATE_PATH, VALIDATE_PARAMS)
        await credentials.setKey(normalizedKey)
      },
    },
    testConnection: async (baseUrl: string, key: string) => {
      const normalizedKey = key.trim()
      if (!normalizedKey) throw new Error('请输入 API 密钥')
      if (!normalizedKey.startsWith('chksz_')) throw new Error('密钥格式不正确')
      if (!baseUrl.trim()) throw new Error('请输入 API 地址')
      
      const candidate = new ChkszClient({ 
        getKey: async () => normalizedKey, 
        queue, 
        baseUrl: baseUrl.trim() 
      })
      await candidate.get(VALIDATE_PATH, VALIDATE_PARAMS)
    },
    music: {
      // 参数校验 + limit clamp，与桌面版 IPC 一致（register.ts）；neteaseSearchFree 设置决定网易云搜索走免费老接口还是 ChKSz。
      search: async (platform, keyword, limit) => {
        if (!SEARCH_PLATFORMS.includes(platform as (typeof SEARCH_PLATFORMS)[number])) {
          throw new AppError({ code: 'BAD_REQUEST', message: '平台参数不合法' })
        }
        const query = String(keyword ?? '').trim()
        if (!query) throw new AppError({ code: 'BAD_REQUEST', message: '请输入搜索内容' })
        const count = Math.min(30, Math.max(1, Number(limit) || 20))
        const { neteaseSearchFree, qqSearchFree, kugouSearchFree } = await settings.get()
        return music.search(platform, query, count, undefined, { netease: neteaseSearchFree, qq: qqSearchFree, kugou: kugouSearchFree })
      },
      getPlayback: (song, quality, forceRefresh) => music.getPlayback(song, quality, forceRefresh),
      importNeteasePlaylist: (input) => music.importNeteasePlaylist(input),
      savedNeteasePlaylists: () => music.savedNeteasePlaylists(),
      neteasePlaylistById: (id, forceRefresh) => music.neteasePlaylistById(id, forceRefresh),
      recommendNeteasePlaylists: (cat, limit, before) => music.recommendNeteasePlaylists(cat, limit, before),
      hotNeteasePlaylists: (cat, limit, offset) => music.hotNeteasePlaylists(String(cat ?? ''), Number(limit) || 12, Number(offset) || 0),
      personalizedPlaylists: (limit) => music.personalizedPlaylists(Number(limit) || 6),
      toplists: () => music.toplists(),
      searchNeteasePlaylists: (keyword, limit, offset) => music.searchNeteasePlaylists(keyword, limit, offset),
      clearCache: async () => music.clearCache(),
      getNeteaseLyric: (songId) => music.getNeteaseLyric(songId),
    },
    library: {
      get: () => library.getSnapshot(),
      toggleFavorite: (song) => library.toggleFavorite(song),
      recordPlayed: (song) => library.recordPlayed(song),
      createPlaylist: (name) => library.createPlaylist(name),
      renamePlaylist: (id, name) => library.renamePlaylist(id, name),
      deletePlaylist: (id) => library.deletePlaylist(id),
      addSong: (playlistId, song) => library.addSong(playlistId, song),
      addSongs: (playlistId, songs) => library.addSongs(playlistId, songs),
      removeSong: (playlistId, songKey) => library.removeSong(playlistId, songKey),
      reorderSong: (playlistId, from, to) => library.reorderSong(playlistId, from, to),
      clearHistory: () => library.clearHistory(),
    },
    settings: {
      get: () => settings.get(),
      update: async (patch) => {
        const next = await settings.update(patch)
        if (patch.apiBaseUrl !== undefined) applyBaseUrl(next.apiBaseUrl)
        return next
      },
    },
    downloads: {
      // Task 9+11 原生下载：先取可播放直链，再交给 SystemPlugin 后台写入公共 Download 目录。
      // 成功 resolve {status:'saved', path}；失败抛 AppError(DOWNLOAD)（与桌面版 Downloader 语义一致，
      // 原生错误消息如"需要 Android 10 及以上版本"直接透传给 UI 提示）。
      save: async (song, quality, taskId) => {
        // forceRefresh：下载要新鲜的直链（播放缓存里的签名 URL 可能已过期），
        // 与 Task 9 原有语义一致；代价是每次下载重新取一次地址（消耗额度）。
        const source = await music.getPlayback(song, quality, true)
        try {
          return await systemBridge.download({
            // taskId 缺省时兜底生成一个（原生下载进度事件按它回推，必须非空）。
            taskId: taskId ?? crypto.randomUUID(),
            title: song.name,
            artist: song.artists.join('、') || '未知歌手',
            url: source.url,
            fileExt: inferAudioExt(source.format, source.url),
          })
        } catch (error) {
          throw new AppError({
            code: 'DOWNLOAD',
            message: error instanceof Error ? error.message : '下载失败',
          })
        }
      },
      // 下载记录：done 时落库；DownloadsProvider 读取历史用。
      getHistory: () => downloads.getDownloads(),
      downloadedKeys: () => downloads.downloadedKeys(),
      saveHistory: (record) => downloads.save(record),
    },
    quota: {
      // 读展示值：同日返回真实捕获值；跨日或从未捕获 → 回落用户设置的每日额度（每日重置语义）。
      get: async () => {
        const record = await quota.get()
        if (record && record.date === todayKey()) return record.freeQuota
        const s = await settings.get()
        return s.dailyQuota
      },
      // 手动刷新：发一笔最小真实收费请求（网易搜索 limit=1），借其响应头刷新额度。
      // 会消耗 1 次免费额度，调用方（ProfilePage）须先弹窗告知用户。
      refresh: async (): Promise<number | null> => {
        await client.get('/api/163_search', { keyword: '晴天', limit: 1 })
        return Promise.resolve(client.getFreeQuota())
      },
      // 原生取地址响应头带回的免费额度：落库（带当天日期），供 ProfilePage 展示。
      save: (freeQuota) => quota.set({ freeQuota, date: todayKey() }),
    },
    player: playerBridge,
  } satisfies ChkszApi
}
