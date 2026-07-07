import { describe, it, expect } from 'vitest'
import { parsePipfileLock } from '../../src/lockfiles/pipenv'

describe('parsePipfileLock', () => {
  it('resolves a default-section package, stripping the == prefix', () => {
    const lock = JSON.stringify({
      default: {
        requests: { hashes: ['sha256:abc'], version: '==2.31.0' },
      },
    })
    expect(parsePipfileLock(lock)).toEqual([{ name: 'requests', version: '2.31.0' }])
  })

  it('includes a develop-section package', () => {
    const lock = JSON.stringify({
      default: {
        requests: { hashes: ['sha256:abc'], version: '==2.31.0' },
      },
      develop: {
        pytest: { hashes: ['sha256:def'], version: '==8.0.0' },
      },
    })
    const result = parsePipfileLock(lock)
    expect(result.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'pytest', version: '8.0.0' },
      { name: 'requests', version: '2.31.0' },
    ])
  })

  it('deduplicates a package in both sections, with default winning on version disagreement', () => {
    const lock = JSON.stringify({
      default: {
        requests: { hashes: ['sha256:abc'], version: '==2.31.0' },
      },
      develop: {
        requests: { hashes: ['sha256:xyz'], version: '==2.30.0' },
      },
    })
    expect(parsePipfileLock(lock)).toEqual([{ name: 'requests', version: '2.31.0' }])
  })

  it('skips an entry with no version field (editable/VCS/local dependency)', () => {
    const lock = JSON.stringify({
      default: {
        requests: { hashes: ['sha256:abc'], version: '==2.31.0' },
        'my-local-pkg': { editable: true, path: '.' },
      },
    })
    expect(parsePipfileLock(lock)).toEqual([{ name: 'requests', version: '2.31.0' }])
  })
})
