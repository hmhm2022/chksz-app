/** 各平台音质档位（对齐 ChKSz 官网 #quality 的参数值，显示英文档位名）。 */

/** 网易云 level 参数：standard/exhigh/lossless/hires/jyeffect/sky/jymaster（7 档）。 */
export const NETEASE_QUALITIES = ['standard', 'exhigh', 'lossless', 'hires', 'jyeffect', 'sky', 'jymaster'] as const

/** QQ 音乐 size 参数：128k/320k/flac/hires/master（5 档）。 */
export const QQ_QUALITIES = ['128k', '320k', 'flac', 'hires', 'master'] as const

/** 酷狗音乐 size 参数：128k/320k/flac/hires/master（5 档）。 */
export const KUGOU_QUALITIES = ['128k', '320k', 'flac', 'hires', 'master'] as const

/** 未配置时的默认档：网易云 lossless，QQ/酷狗 flac。 */
export const DEFAULT_NETEASE_QUALITY = 'lossless'
export const DEFAULT_QQ_QUALITY = 'flac'
export const DEFAULT_KUGOU_QUALITY = 'flac'

/** 返回 { value, label } 列表（label 即英文档位值）。 */
export function neteaseQualityOptions(): { value: string; label: string }[] {
  return [...NETEASE_QUALITIES].map(value => ({ value, label: value }))
}

export function qqQualityOptions(): { value: string; label: string }[] {
  return [...QQ_QUALITIES].map(value => ({ value, label: value }))
}

export function kugouQualityOptions(): { value: string; label: string }[] {
  return [...KUGOU_QUALITIES].map(value => ({ value, label: value }))
}

/** 档位显示名（即英文值本身）。 */
export const neteaseQualityLabel = (value: string): string => value
export const qqQualityLabel = (value: string): string => value
export const kugouQualityLabel = (value: string): string => value