import type { Song } from '../../contracts'

export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function seconds(value: unknown): number | null {
  const number = numberOrNull(value)
  if (number === null) return null
  return number > 1000 ? Math.round(number / 1000) : Math.round(number)
}

export function artistNames(value: unknown): string[] {
  if (typeof value === 'string') return value.split('/').map(item => item.trim()).filter(Boolean)
  if (!Array.isArray(value)) return []
  return value.map(item => {
    if (typeof item === 'string') return item.trim()
    if (typeof item === 'object' && item !== null && 'name' in item) return text(item.name)
    return ''
  }).filter(Boolean)
}

export function songKey(platform: Song['platform'], id: string): string {
  return `${platform}:${id}`
}

export function formatFromUrl(url: string): string | null {
  const extension = url.split('?')[0]?.split('.').pop()?.toLowerCase()
  return extension && /^[a-z0-9]{2,5}$/.test(extension) ? extension : null
}

/**
 * 封面 URL 强制 HTTPS。
 * Chksz 上游返回的网易云封面是 http://（p3/p4.music.126.net），
 * Capacitor WebView 在 https://localhost 页面里会拦混合内容（实测 http 封面 IMAGE-ERR、https 正常）。
 * 126.net / 各平台图床均支持 https，统一转换避免真机封面加载失败。
 */
export function httpsCover(value: unknown): string {
  const url = text(value)
  return url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url
}
