import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as core from '@actions/core'
import * as github from '@actions/github'
import { buildMarkdownTable, writeJobSummary, upsertPrComment } from '../src/report'
import { isBelowThreshold } from '../src/index'
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

  it('shows the below-threshold link for a scored package that fails a configured threshold', () => {
    const scores: PackageScore[] = [
      { name: 'risky-pkg', version: '1.0.0', generalScore: 30, automationScore: 80, riskScore: 20, status: 'scored' },
    ]
    const table = buildMarkdownTable(scores, { general: 50, automation: null, risk: null })
    expect(table).toContain('[Below threshold — see why →](https://packagerating.com/packages/risky-pkg)')
  })

  it('shows no link for a scored package that passes every configured threshold', () => {
    const scores: PackageScore[] = [
      { name: 'good-pkg', version: '1.0.0', generalScore: 90, automationScore: 90, riskScore: 10, status: 'scored' },
    ]
    const table = buildMarkdownTable(scores, { general: 50, automation: 50, risk: 50 })
    expect(table).not.toContain('Below threshold')
  })

  it('shows no link when no threshold is configured at all', () => {
    const scores: PackageScore[] = [
      { name: 'low-pkg', version: '1.0.0', generalScore: 5, automationScore: 5, riskScore: 95, status: 'scored' },
    ]
    const table = buildMarkdownTable(scores, noThresholds)
    expect(table).not.toContain('Below threshold')
  })

  it('prioritizes the crawl-timed-out note over the below-threshold link', () => {
    const scores: PackageScore[] = [
      // generalScore is non-null and would fail the configured general threshold (10 < 50) if
      // isBelowThreshold were checked — so this only passes if the 'unscored' branch genuinely
      // runs first, not merely because isBelowThreshold happens to return false.
      { name: 'timed-out-pkg', version: null, generalScore: 10, automationScore: null, riskScore: null, status: 'unscored' },
    ]
    const table = buildMarkdownTable(scores, { general: 50, automation: null, risk: null })
    expect(table).toContain('Crawl timed out')
    expect(table).not.toContain('Below threshold')
  })

  it('prioritizes the crawl-error note over the below-threshold link', () => {
    const scores: PackageScore[] = [
      // Same fixture-strengthening as the unscored case above: non-null generalScore that would
      // fail the configured threshold, so the test only passes if 'crawl-error' is checked first.
      { name: 'broken-pkg', version: null, generalScore: 10, automationScore: null, riskScore: null, status: 'crawl-error' },
    ]
    const table = buildMarkdownTable(scores, { general: 50, automation: null, risk: null })
    expect(table).toContain('Crawl error')
    expect(table).not.toContain('Below threshold')
  })

  it('percent-encodes parens in the package name so the link destination is not truncated', () => {
    const scores: PackageScore[] = [
      { name: 'evil) https://phish.example (', version: '1.0.0', generalScore: 30, automationScore: 80, riskScore: 20, status: 'scored' },
    ]
    const table = buildMarkdownTable(scores, { general: 50, automation: null, risk: null })
    expect(table).toContain(
      '[Below threshold — see why →](https://packagerating.com/packages/evil%29%20https%3A%2F%2Fphish.example%20%28)',
    )
    expect(table).not.toContain('](https://packagerating.com/packages/evil)')
  })

  it('renders an ordinary name containing parens safely', () => {
    const scores: PackageScore[] = [
      { name: 'foo(bar)', version: '1.0.0', generalScore: 30, automationScore: 80, riskScore: 20, status: 'scored' },
    ]
    const table = buildMarkdownTable(scores, { general: 50, automation: null, risk: null })
    expect(table).toContain(
      '[Below threshold — see why →](https://packagerating.com/packages/foo%28bar%29)',
    )
  })
})

describe('isBelowThreshold', () => {
  it('returns true when generalScore is below the general threshold', () => {
    expect(isBelowThreshold(
      { name: 'p', version: '1.0.0', generalScore: 40, automationScore: null, riskScore: null, status: 'scored' },
      { general: 50, automation: null, risk: null },
    )).toBe(true)
  })

  it('returns true when automationScore is below the automation threshold', () => {
    expect(isBelowThreshold(
      { name: 'p', version: '1.0.0', generalScore: null, automationScore: 40, riskScore: null, status: 'scored' },
      { general: null, automation: 50, risk: null },
    )).toBe(true)
  })

  it('returns true when riskScore is above the risk threshold', () => {
    expect(isBelowThreshold(
      { name: 'p', version: '1.0.0', generalScore: null, automationScore: null, riskScore: 80, status: 'scored' },
      { general: null, automation: null, risk: 50 },
    )).toBe(true)
  })

  it('returns false when no threshold is configured', () => {
    expect(isBelowThreshold(
      { name: 'p', version: '1.0.0', generalScore: 1, automationScore: 1, riskScore: 99, status: 'scored' },
      { general: null, automation: null, risk: null },
    )).toBe(false)
  })

  it('returns false when all configured thresholds pass', () => {
    expect(isBelowThreshold(
      { name: 'p', version: '1.0.0', generalScore: 90, automationScore: 90, riskScore: 10, status: 'scored' },
      { general: 50, automation: 50, risk: 50 },
    )).toBe(false)
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
