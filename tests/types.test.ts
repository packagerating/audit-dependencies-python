import { describe, it, expect } from 'vitest'
import type { PackageScore, Thresholds } from '../src/types'

describe('types', () => {
  it('PackageScore accepts a fully-populated scored package', () => {
    const score: PackageScore = {
      name: 'requests',
      version: '2.31.0',
      generalScore: 84,
      automationScore: 88,
      riskScore: 12,
      status: 'scored',
    }
    expect(score.name).toBe('requests')
  })

  it('Thresholds accepts all-null (no gating configured)', () => {
    const thresholds: Thresholds = { general: null, automation: null, risk: null }
    expect(thresholds.general).toBeNull()
  })
})
