import type { PlaybackSource, Song } from '../../contracts'
import { artistNames, formatFromUrl, httpsCover, seconds, songKey, text } from './helpers'

export function mapKugouSearch(payload: any): Song[] {
  const list = Array.isArray(payload?.list) ? payload.list : []
  return list.map((item: any) => {
    const id = text(item.id)
    return {
      key: songKey('kugou', id),
      platform: 'kugou',
      id,
      // 新版搜索列表字段为 name/singer/album，旧版为 SongName/SingerName/AlbumName
      name: text(item.name) || text(item.SongName, '未命名歌曲'),
      artists: artistNames(item.singer ?? item.SingerName),
      album: text(item.album) || text(item.AlbumName),
      cover: httpsCover(item.Image ?? item.AlbumImage),
      duration: seconds(item.duration ?? item.Duration ?? item.timeLength),
      qualities: []
    }
  }).filter((song: Song) => song.id)
}

export function mapKugouDetail(payload: any, song: Song): { song: Song; source: PlaybackSource } {
  // 新版详情字段在顶层（url/cover/lrc/bitrate/format/name/singer/album），旧版在 data 里
  const data = payload?.data ?? {}
  const isNew = 'url' in payload || 'name' in payload || 'singer' in payload
  const url = text(isNew ? payload.url : data.url)
  const quality = text(isNew ? payload.bitrate : data.quality) || formatFromUrl(url) || '默认'
  const updatedSong: Song = {
    ...song,
    name: text(isNew ? payload.name : data.songName, song.name),
    artists: artistNames(isNew ? payload.singer : data.singerName),
    album: text(isNew ? payload.album : data.albumName, song.album),
    cover: text(isNew ? payload.cover : data.albumImage, song.cover),
    duration: seconds(isNew ? payload.interval : data.timeLength) ?? song.duration,
    qualities: [quality]
  }
  return {
    song: updatedSong,
    source: {
      songKey: song.key,
      url,
      quality,
      format: text(isNew ? payload.format : data.extName) || formatFromUrl(url),
      lyric: text(isNew ? payload.lrc : data.lyrics),
      translatedLyric: ''
    }
  }
}
