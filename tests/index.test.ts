import { describe, it, expect, vi, beforeEach } from 'vitest'
import { checkThresholds } from '../src/index'
import type { PackageScore, Thresholds } from '../src/types'

function scored(name: string, generalScore: number, automationScore: number, riskScore: number): PackageScore {
  return { name, version: '1.0.0', generalScore, automationScore, riskScore, status: 'scored' }
}

describe('checkThresholds', () => {
  it('returns no failures when all scores pass', () => {
    const failures = checkThresholds([scored('requests', 80, 80, 10)], { general: 50, automation: 50, risk: 50 })
    expect(failures).toEqual([])
  })

  it('fails when generalScore is below the general threshold', () => {
    const failures = checkThresholds([scored('requests', 30, 80, 10)], { general: 50, automation: null, risk: null })
    expect(failures).toEqual(['requests (general: 30 < 50)'])
  })

  it('fails when riskScore is above the risk threshold', () => {
    const failures = checkThresholds([scored('requests', 80, 80, 70)], { general: null, automation: null, risk: 50 })
    expect(failures).toEqual(['requests (risk: 70 > 50)'])
  })

  it('ignores unscored packages entirely', () => {
    const scores: PackageScore[] = [
      { name: 'missing', version: null, generalScore: null, automationScore: null, riskScore: null, status: 'unscored' },
    ]
    const failures = checkThresholds(scores, { general: 50, automation: 50, risk: 50 })
    expect(failures).toEqual([])
  })

  it('combines multiple threshold failures for the same package', () => {
    const failures = checkThresholds([scored('requests', 30, 20, 70)], { general: 50, automation: 50, risk: 50 })
    expect(failures).toEqual(['requests (general: 30 < 50, automation: 20 < 50, risk: 70 > 50)'])
  })
})

describe('run() integration', () => {
  let getInputMock: ReturnType<typeof vi.fn>
  let setOutputMock: ReturnType<typeof vi.fn>
  let setFailedMock: ReturnType<typeof vi.fn>
  let discoverPackagesMock: ReturnType<typeof vi.fn>
  let scorePackagesMock: ReturnType<typeof vi.fn>
  let writeJobSummaryMock: ReturnType<typeof vi.fn>
  let upsertPrCommentMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()

    getInputMock = vi.fn()
    setOutputMock = vi.fn()
    setFailedMock = vi.fn()
    discoverPackagesMock = vi.fn().mockReturnValue([{ name: 'requests', version: '2.31.0' }])
    scorePackagesMock = vi.fn().mockResolvedValue([scored('requests', 80, 80, 10)])
    writeJobSummaryMock = vi.fn().mockResolvedValue(undefined)
    upsertPrCommentMock = vi.fn().mockResolvedValue(undefined)

    vi.doMock('@actions/core', () => ({
      getInput: (...args: unknown[]) => getInputMock(...args),
      setOutput: (...args: unknown[]) => setOutputMock(...args),
      setFailed: (...args: unknown[]) => setFailedMock(...args),
      info: vi.fn(),
      warning: vi.fn(),
      summary: {
        addHeading: vi.fn().mockReturnThis(),
        addRaw: vi.fn().mockReturnThis(),
        addEOL: vi.fn().mockReturnThis(),
        write: vi.fn().mockResolvedValue(undefined),
      },
    }))
    vi.doMock('../src/discover', () => ({
      discoverPackages: (...args: unknown[]) => discoverPackagesMock(...args),
    }))
    vi.doMock('../src/score', () => ({
      scorePackages: (...args: unknown[]) => scorePackagesMock(...args),
    }))
    vi.doMock('../src/report', () => ({
      writeJobSummary: (...args: unknown[]) => writeJobSummaryMock(...args),
      upsertPrComment: (...args: unknown[]) => upsertPrCommentMock(...args),
    }))
  })

  async function runWithInputs(inputs: Record<string, string>): Promise<void> {
    const defaults: Record<string, string> = {
      'api-key': 'test-key',
      'requirements-path': 'requirements.txt',
      packages: '',
      'audit-subprojects': 'true',
      'subproject-max-depth': '3',
      'subproject-exclude': '',
      'fail-on-general': '',
      'fail-on-automation': '',
      'fail-on-risk': '',
      'pr-comment': 'false',
      'github-token': '',
      'crawl-timeout': '10',
    }
    const merged = { ...defaults, ...inputs }
    getInputMock.mockImplementation((name: string) => merged[name] ?? '')

    const { run } = await import('../src/index')
    await run()
  }

  it('scores explicit packages when the packages input is set, bypassing requirements.txt', async () => {
    discoverPackagesMock.mockReturnValue([
      { name: 'flask', version: null },
      { name: 'django', version: null },
    ])
    scorePackagesMock.mockResolvedValue([
      { name: 'flask', version: null, generalScore: 80, automationScore: 80, riskScore: 10, status: 'scored' },
      { name: 'django', version: null, generalScore: 80, automationScore: 80, riskScore: 10, status: 'scored' },
    ])

    await runWithInputs({ packages: 'flask,django' })

    expect(discoverPackagesMock).toHaveBeenCalledWith('requirements.txt', ['flask', 'django'], true, 3, [])
    expect(scorePackagesMock).toHaveBeenCalled()
  })

  it('reads the requirements-path input and passes it through to discoverPackages', async () => {
    await runWithInputs({ 'requirements-path': 'reqs/prod.txt' })
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[0]).toBe('reqs/prod.txt')
  })

  it('passes auditSubprojects=true to discoverPackages by default', async () => {
    await runWithInputs({})
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[2]).toBe(true)
  })

  it('passes auditSubprojects=false to discoverPackages when audit-subprojects input is "false"', async () => {
    await runWithInputs({ 'audit-subprojects': 'false' })
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[2]).toBe(false)
  })

  it('passes subprojectMaxDepth=3 to discoverPackages by default', async () => {
    await runWithInputs({})
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[3]).toBe(3)
  })

  it('passes a custom subprojectMaxDepth to discoverPackages when subproject-max-depth is set', async () => {
    await runWithInputs({ 'subproject-max-depth': '5' })
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[3]).toBe(5)
  })

  it('passes an empty subprojectExcludeGlobs array to discoverPackages by default', async () => {
    await runWithInputs({})
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[4]).toEqual([])
  })

  it('parses subproject-exclude into a trimmed array of globs', async () => {
    await runWithInputs({ 'subproject-exclude': 'scratch/**, tmp/** ' })
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[4]).toEqual(['scratch/**', 'tmp/**'])
  })

  it('reads the github-token input and passes it through to upsertPrComment', async () => {
    await runWithInputs({ 'pr-comment': 'true', 'github-token': 'gh-token-123' })
    expect(upsertPrCommentMock).toHaveBeenCalledTimes(1)
    const [, , token] = upsertPrCommentMock.mock.calls[0]!
    expect(token).toBe('gh-token-123')
  })

  it('calls writeJobSummary before gating regardless of outcome', async () => {
    scorePackagesMock.mockResolvedValue([scored('requests', 10, 10, 10)])
    await runWithInputs({ 'fail-on-general': '50' })
    expect(writeJobSummaryMock).toHaveBeenCalledTimes(1)
    expect(setFailedMock).toHaveBeenCalled()
  })

  it('calls core.setFailed when a package fails a threshold', async () => {
    scorePackagesMock.mockResolvedValue([scored('requests', 10, 80, 80)])
    await runWithInputs({ 'fail-on-general': '50' })
    expect(setFailedMock).toHaveBeenCalledWith(expect.stringContaining('requests'))
  })

  it('does not call core.setFailed when no package fails a threshold', async () => {
    scorePackagesMock.mockResolvedValue([scored('requests', 80, 80, 80)])
    await runWithInputs({ 'fail-on-general': '50' })
    expect(writeJobSummaryMock).toHaveBeenCalledTimes(1)
    expect(setFailedMock).not.toHaveBeenCalled()
  })
})
