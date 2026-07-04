import { describe, it, expect, vi, beforeEach } from 'vitest'
import { scorePackages } from '../src/score'
import type { DiscoveredPackage } from '../src/discover'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function ok(body: unknown, status = 200) {
  return Promise.resolve({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) })
}
function notFound() {
  return Promise.resolve({ status: 404, ok: false, json: () => Promise.resolve({ error: 'not found' }) })
}
function serverError() {
  return Promise.resolve({ status: 500, ok: false, json: () => Promise.resolve({}) })
}
function accepted(jobId: string) {
  return Promise.resolve({ status: 202, ok: false, json: () => Promise.resolve({ job_id: jobId }) })
}

function pkg(name: string, version: string | null = null): DiscoveredPackage {
  return { name, version }
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('scorePackages', () => {
  it('returns scored package on a direct 200', async () => {
    mockFetch.mockResolvedValue(ok({ general_score: 84, automation_score: 88, risk_score: 12, version: '2.31.0' }))
    const result = await scorePackages([pkg('requests')], 'key', 10)
    expect(result).toEqual([{
      name: 'requests', version: '2.31.0', generalScore: 84, automationScore: 88, riskScore: 12, status: 'scored',
    }])
  })

  it('always includes language=python in the request URL', async () => {
    mockFetch.mockResolvedValue(ok({ general_score: 84, automation_score: 88, risk_score: 12, version: '2.31.0' }))
    await scorePackages([pkg('requests')], 'key', 10)
    const [url] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.packagerating.com/packages/requests?language=python')
  })

  it('includes both language=python and version when a version is given', async () => {
    mockFetch.mockResolvedValue(ok({ general_score: 84, automation_score: 88, risk_score: 12, version: '2.31.0' }))
    await scorePackages([pkg('requests', '2.31.0')], 'key', 10)
    const [url] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.packagerating.com/packages/requests?language=python&version=2.31.0')
  })

  it('sends the x-api-key header', async () => {
    mockFetch.mockResolvedValue(ok({ general_score: 84, automation_score: 88, risk_score: 12, version: '2.31.0' }))
    await scorePackages([pkg('requests')], 'my-secret-key', 10)
    const [, options] = mockFetch.mock.calls[0]!
    expect((options as { headers: Record<string, string> }).headers['x-api-key']).toBe('my-secret-key')
  })

  it('returns unscored on a direct 404', async () => {
    mockFetch.mockResolvedValue(notFound())
    const result = await scorePackages([pkg('nonexistent-pkg')], 'key', 10)
    expect(result).toEqual([{
      name: 'nonexistent-pkg', version: null, generalScore: null, automationScore: null, riskScore: null, status: 'unscored',
    }])
  })

  it('returns crawl-error on a non-ok, non-404, non-202 response', async () => {
    mockFetch.mockResolvedValue(serverError())
    const result = await scorePackages([pkg('requests')], 'key', 10)
    expect(result[0]!.status).toBe('crawl-error')
  })

  it('returns crawl-error when fetch itself throws', async () => {
    mockFetch.mockRejectedValue(new Error('network down'))
    const result = await scorePackages([pkg('requests')], 'key', 10)
    expect(result[0]!.status).toBe('crawl-error')
  })

  it('polls the job from a 202 response and returns scored once done', async () => {
    vi.useFakeTimers()
    mockFetch
      .mockResolvedValueOnce(accepted('job-1'))
      .mockResolvedValueOnce(ok({ status: 'processing' }))
      .mockResolvedValueOnce(ok({ status: 'done' }))
      .mockResolvedValueOnce(ok({ general_score: 70, automation_score: 60, risk_score: 20, version: '2.31.0' }))

    const promise = scorePackages([pkg('requests')], 'key', 30)
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(5000)
    }
    const result = await promise

    expect(result[0]!.status).toBe('scored')
    expect(result[0]!.generalScore).toBe(70)
    vi.useRealTimers()
  })

  it('returns unscored if the job finishes but the re-fetch is a 404', async () => {
    vi.useFakeTimers()
    mockFetch
      .mockResolvedValueOnce(accepted('job-2'))
      .mockResolvedValueOnce(ok({ status: 'done' }))
      .mockResolvedValueOnce(notFound())

    const promise = scorePackages([pkg('requests')], 'key', 30)
    await vi.advanceTimersByTimeAsync(5000)
    const result = await promise

    expect(result[0]!.status).toBe('unscored')
    vi.useRealTimers()
  })

  it('scores multiple packages independently', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ general_score: 84, automation_score: 88, risk_score: 12, version: '2.31.0' }))
      .mockResolvedValueOnce(notFound())

    const result = await scorePackages([pkg('requests', '2.31.0'), pkg('nonexistent-pkg')], 'key', 10)
    expect(result).toHaveLength(2)
    expect(result.find(r => r.name === 'requests')!.status).toBe('scored')
    expect(result.find(r => r.name === 'nonexistent-pkg')!.status).toBe('unscored')
  })
})
