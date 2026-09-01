import type { PlaybackSource, Song } from '../../contracts'
import { artistNames, formatFromUrl, numberOrNull, seconds, songKey, text } from './helpers'

function qqCover(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    return text(value && 'large' in value ? value.large : '') || text(value && 'medium' in value ? value.medium : '') || text(value && 'small' in value ? value.small : '')
  }
  return ''
}

export function mapQqSearch(payload: any): Song[] {
  const list = Array.isArray(payload?.list) ? payload.list : []
  return list.map((item: any) => {
    // 新版搜索列表字段为 mid/singer，旧版为 id/artists
    const id = text(item.mid ?? item.id)
    return {
      key: songKey('qq', id),
      platform: 'qq',
      id,
      name: text(item.name, '未命名歌曲'),
      artists: artistNames(item.singer ?? item.artists),
      album: text(item.album),
      // 搜索列表本身无 cover 字段，封面由外部免费接口按 mid 补齐（见 qq-cover）。
      cover: qqCover(item.cover),
      duration: seconds(item.duration),
      qualities: []
    }
  }).filter((song: Song) => song.id)
}

export function mapQqDetail(payload: any, song: Song): PlaybackSource {
  const url = text(payload?.url)
  const quality = text(payload?.bitrate) || text(payload?.quality) || formatFromUrl(url) || '默认'
  const lyric = text(payload?.lrc) || text(payload?.lyric?.text ?? payload?.lyric)
  return {
    songKey: song.key,
    url,
    quality,
    format: text(payload?.format) || formatFromUrl(url),
    lyric,
    translatedLyric: text(payload?.lyric?.translation ?? payload?.lyric?.trans)
  }
}

export function mapQqSongDetail(payload: any, song: Song): Song {
  return {
    ...song,
    name: text(payload?.name, song.name),
    artists: artistNames(payload?.singer).length ? artistNames(payload.singer) : song.artists,
    album: text(payload?.album?.name, song.album),
    cover: qqCover(payload?.cover) || song.cover,
    duration: numberOrNull(payload?.duration) ?? song.duration,
    qualities: [text(payload?.bitrate) || text(payload?.quality)].filter(Boolean)
  }
}
