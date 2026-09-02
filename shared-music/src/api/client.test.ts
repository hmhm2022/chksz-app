import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../contracts'
import { ChkszClient } from './client'
import { RequestQueue } from './request-queue'

describe('ChkszClient API address', () => {
  it('rejects requests while no API address is configured', async () => {
    const fetcher = vi.fn()
    const client = new ChkszClient({
      getKey: async () => 'chksz_test',
      queue: new RequestQueue(),
      baseUrl: '',
      fetcher,
    })

    await expect(client.get('/api/test', {})).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: '请先填写 API 地址',
    } satisfies Partial<AppError>)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('uses the address supplied later by the user', async () => {
    const fetcher = vi.fn(async (url: string) => new Response('{}', { status: 200 }))
    const client = new ChkszClient({
      getKey: async () => 'chksz_test',
      queue: new RequestQueue(),
      baseUrl: '',
      fetcher,
    })

    client.setBaseUrl('https://example.test')
    await client.get('/api/test', {})

    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('https://example.test/api/test?apikey=chksz_test'),
      expect.anything(),
    )
  })
})
