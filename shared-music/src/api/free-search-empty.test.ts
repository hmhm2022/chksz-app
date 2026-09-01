import { describe, expect, it } from 'vitest'
import { MusicService } from './music-service'
import { searchKugouFree } from './adapters/kugou-search'
import { searchNeteaseFree } from './adapters/netease-search'
import { searchQqFree } from './adapters/qq-search'

function fetchJson(body: unknown, status = 200): typeof fetch {
  return async (_input, _init) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function failingFetch(): typeof fetch {
  return async () => { throw new Error('network down') }
}

const client = { get: async () => { throw new Error('ChKSz client should not be called') } }

describe('免费搜索空结果', () => {
  it('QQ 和酷狗把有效空列表返回为 []', async () => {
    const qq = await searchQqFree('不存在', fetchJson({ data: { song: { list: [] } } }))
    const kugou = await searchKugouFree('不存在', fetchJson({ data: { info: [] } }))

    expect(qq).toEqual([])
    expect(kugou).toEqual([])
  })

  it('网易云把有效空列表返回为 []', async () => {
    const songs = await searchNeteaseFree('不存在', fetchJson({ result: { songs: [] } }))
    expect(songs).toEqual([])
  })

  it('请求失败仍保留失败语义', async () => {
    await expect(searchQqFree('关键词', failingFetch())).resolves.toBeNull()
    await expect(searchKugouFree('关键词', fetchJson({}, 503))).resolves.toBeNull()
    await expect(searchNeteaseFree('关键词', failingFetch())).rejects.toThrow('免费网易搜索源不可用')
  })
})

describe('MusicService 免费搜索结果分类', () => {
  it('三平台成功但无结果时返回空数组', async () => {
    const service = new MusicService(client, fetchJson({ result: { songs: [] } }))
    const netease = await service.search('netease', '不存在')

    const qqService = new MusicService(client, fetchJson({ data: { song: { list: [] } } }))
    const qq = await qqService.search('qq', '不存在')

    const kugouService = new MusicService(client, fetchJson({ data: { info: [] } }))
    const kugou = await kugouService.search('kugou', '不存在')

    expect(netease).toEqual([])
    expect(qq).toEqual([])
    expect(kugou).toEqual([])
  })

  it('免费源请求失败时仍抛出不可用错误', async () => {
    const service = new MusicService(client, fetchJson({}, 503))
    await expect(service.search('qq', '关键词')).rejects.toThrow('免费 QQ 搜索源不可用')
  })
})
