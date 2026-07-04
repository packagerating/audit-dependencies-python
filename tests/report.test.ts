import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as core from '@actions/core'
import * as github from '@actions/github'
import { buildMarkdownTable, writeJobSummary, upsertPrComment } from '../src/report'
import type { PackageScore, Thresholds } from '../src/types'

function scored(name: string, generalScore: number, automationScore: number, riskScore: number, version = '1.0.0'): PackageScore {
  return { name, version, generalScore, automationScore, riskScore, status: 'scored' }
}

const noThresholds: Thresholds = { general: null, automation: null, risk: null }

describe('buildMarkdownTable', () => {
  it('sorts ascending by generalScore, unscored packages last', () => {
    const scores: PackageScore[] = [
      scored('high', 90, 90, 5),
      scored('low', 20, 30, 60),
      { name: 'missing', version: null, generalScore: null, automationScore: null, riskScore: null, status: 'unscored' },
    ]
    const table = buildMarkdownTable(scores, noThresholds)
    const lines = table.split('\n').filter(l => l.startsWith('|') && !l.startsWith('|---'))
    const names = lines.slice(1).map(l => l.split('|')[1]!.trim())
    expect(names).toEqual(['low', 'high', 'missing'])
  })

  it('marks a score below the general threshold with a warning', () => {
    const scores = [scored('flask', 40, 90, 5)]
    const table = buildMarkdownTable(scores, { general: 50, automation: null, risk: null })
    expect(table).toContain('40 ⚠️')
  })

  it('marks a score at or above the general threshold with a checkmark', () => {
    const scores = [scored('flask', 60, 90, 5)]
    const table = buildMarkdownTable(scores, { general: 50, automation: null, risk: null })
    expect(table).toContain('60 ✅')
  })

  it('treats risk as lower-is-better: a risk score above threshold warns', () => {
    const scores = [scored('flask', 90, 90, 70)]
    const table = buildMarkdownTable(scores, { general: null, automation: null, risk: 50 })
    expect(table).toContain('70 ⚠️')
  })

  it('shows a note for unscored packages', () => {
    const scores: PackageScore[] = [
      { name: 'missing', version: null, generalScore: null, automationScore: null, riskScore: null, status: 'unscored' },
    ]
    const table = buildMarkdownTable(scores, noThresholds)
    expect(table).toContain('Crawl timed out')
  })

  it('shows a note for crawl-error packages', () => {
    const scores: PackageScore[] = [
      { name: 'broken', version: null, generalScore: null, automationScore: null, riskScore: null, status: 'crawl-error' },
    ]
    const table = buildMarkdownTable(scores, noThresholds)
    expect(table).toContain('Crawl error')
  })
})

describe('writeJobSummary', () => {
  it('writes a heading and the table to the job summary', async () => {
    const addHeading = vi.fn().mockReturnThis()
    const addRaw = vi.fn().mockReturnThis()
    const addEOL = vi.fn().mockReturnThis()
    const write = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(core, 'summary', 'get').mockReturnValue({ addHeading, addRaw, addEOL, write } as unknown as typeof core.summary)

    await writeJobSummary([scored('requests', 84, 88, 12)], noThresholds)

    expect(addHeading).toHaveBeenCalledWith('Package Rating Audit (Python)', 2)
    expect(write).toHaveBeenCalled()
  })
})

describe('upsertPrComment', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('does nothing when not running in a pull_request event', async () => {
    vi.spyOn(github, 'context', 'get').mockReturnValue({ eventName: 'push', payload: {}, repo: { owner: 'o', repo: 'r' } } as unknown as typeof github.context)
    const getOctokitSpy = vi.spyOn(github, 'getOctokit')
    await upsertPrComment([scored('requests', 84, 88, 12)], noThresholds, 'token')
    expect(getOctokitSpy).not.toHaveBeenCalled()
  })

  it('does nothing when no token is provided', async () => {
    vi.spyOn(github, 'context', 'get').mockReturnValue({
      eventName: 'pull_request',
      payload: { pull_request: { number: 1 } },
      repo: { owner: 'o', repo: 'r' },
    } as unknown as typeof github.context)
    const getOctokitSpy = vi.spyOn(github, 'getOctokit')
    await upsertPrComment([scored('requests', 84, 88, 12)], noThresholds, '')
    expect(getOctokitSpy).not.toHaveBeenCalled()
  })

  it('creates a new comment when none exists yet', async () => {
    vi.spyOn(github, 'context', 'get').mockReturnValue({
      eventName: 'pull_request',
      payload: { pull_request: { number: 7 } },
      repo: { owner: 'o', repo: 'r' },
    } as unknown as typeof github.context)

    const createComment = vi.fn().mockResolvedValue(undefined)
    const listComments = vi.fn().mockResolvedValue({ data: [] })
    vi.spyOn(github, 'getOctokit').mockReturnValue({
      rest: { issues: { listComments, createComment, updateComment: vi.fn() } },
    } as unknown as ReturnType<typeof github.getOctokit>)

    await upsertPrComment([scored('requests', 84, 88, 12)], noThresholds, 'token')

    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({ owner: 'o', repo: 'r', issue_number: 7 }))
  })

  it('updates the existing comment when one already exists', async () => {
    vi.spyOn(github, 'context', 'get').mockReturnValue({
      eventName: 'pull_request',
      payload: { pull_request: { number: 7 } },
      repo: { owner: 'o', repo: 'r' },
    } as unknown as typeof github.context)

    const updateComment = vi.fn().mockResolvedValue(undefined)
    const listComments = vi.fn().mockResolvedValue({
      data: [{ id: 42, body: '<!-- packagerating-audit-python -->\nold content' }],
    })
    vi.spyOn(github, 'getOctokit').mockReturnValue({
      rest: { issues: { listComments, createComment: vi.fn(), updateComment } },
    } as unknown as ReturnType<typeof github.getOctokit>)

    await upsertPrComment([scored('requests', 84, 88, 12)], noThresholds, 'token')

    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 42 }))
  })
})
