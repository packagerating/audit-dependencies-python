import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { discoverSubprojects } from '../src/subprojects'

let rootDir: string

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subprojects-test-'))
})

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true })
})

function write(relPath: string, content: string): void {
  const full = path.join(rootDir, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

describe('discoverSubprojects', () => {
  it('finds a subproject root marked by requirements.txt', () => {
    write('service-a/requirements.txt', 'requests==2.31.0\n')
    const result = discoverSubprojects(rootDir, 3, [])
    expect(result).toEqual(['service-a'])
  })

  it('finds a subproject root marked by pyproject.toml', () => {
    write('service-a/pyproject.toml', '[project]\nname = "service-a"\n')
    const result = discoverSubprojects(rootDir, 3, [])
    expect(result).toEqual(['service-a'])
  })

  it('finds a subproject root marked by Pipfile', () => {
    write('service-a/Pipfile', '[packages]\nrequests = "*"\n')
    const result = discoverSubprojects(rootDir, 3, [])
    expect(result).toEqual(['service-a'])
  })

  it('returns a directory with multiple marker files only once', () => {
    write('service-a/requirements.txt', 'requests==2.31.0\n')
    write('service-a/pyproject.toml', '[project]\nname = "service-a"\n')
    const result = discoverSubprojects(rootDir, 3, [])
    expect(result).toEqual(['service-a'])
  })

  it('never includes the root\'s own directory', () => {
    write('requirements.txt', 'requests==2.31.0\n')
    write('service-a/requirements.txt', 'flask==3.0.0\n')
    const result = discoverSubprojects(rootDir, 3, [])
    expect(result).toEqual(['service-a'])
  })

  it('finds subproject roots at multiple depths up to maxDepth', () => {
    write('service-a/requirements.txt', 'requests==2.31.0\n')
    write('apps/service-b/pyproject.toml', '[project]\nname = "service-b"\n')
    const result = discoverSubprojects(rootDir, 3, [])
    expect(result.sort()).toEqual(['apps/service-b', 'service-a'])
  })

  it('stops at maxDepth and does not return deeper matches', () => {
    write('a/b/c/requirements.txt', 'requests==2.31.0\n')
    const result = discoverSubprojects(rootDir, 2, [])
    expect(result).toEqual([])
  })

  it('includes a match exactly at maxDepth', () => {
    write('a/b/requirements.txt', 'requests==2.31.0\n')
    const result = discoverSubprojects(rootDir, 2, [])
    expect(result).toEqual(['a/b'])
  })

  it('always excludes node_modules even when not listed in extraExcludeGlobs', () => {
    write('service-a/requirements.txt', 'requests==2.31.0\n')
    write('node_modules/some-dep/requirements.txt', 'flask==3.0.0\n')
    const result = discoverSubprojects(rootDir, 3, [])
    expect(result).toEqual(['service-a'])
  })

  it('always excludes Python-specific default directories (venv, .venv, __pycache__, .tox, site-packages)', () => {
    write('service-a/requirements.txt', 'requests==2.31.0\n')
    write('venv/leftover/requirements.txt', 'x==1.0.0\n')
    write('.venv/leftover/requirements.txt', 'x==1.0.0\n')
    write('__pycache__/leftover/requirements.txt', 'x==1.0.0\n')
    write('.tox/leftover/requirements.txt', 'x==1.0.0\n')
    write('site-packages/leftover/requirements.txt', 'x==1.0.0\n')
    const result = discoverSubprojects(rootDir, 3, [])
    expect(result).toEqual(['service-a'])
  })

  it('always excludes common test-fixture directories (examples, fixtures, test, tests, __tests__, e2e)', () => {
    write('service-a/requirements.txt', 'requests==2.31.0\n')
    write('examples/demo/requirements.txt', 'x==1.0.0\n')
    write('fixtures/fake/requirements.txt', 'x==1.0.0\n')
    write('test/fixture-app/requirements.txt', 'x==1.0.0\n')
    write('tests/fixture-app/requirements.txt', 'x==1.0.0\n')
    write('__tests__/fixture-app/requirements.txt', 'x==1.0.0\n')
    write('e2e/fixture-app/requirements.txt', 'x==1.0.0\n')
    const result = discoverSubprojects(rootDir, 3, [])
    expect(result).toEqual(['service-a'])
  })

  it('suppresses an otherwise-matching directory via extraExcludeGlobs', () => {
    write('service-a/requirements.txt', 'requests==2.31.0\n')
    write('scratch/requirements.txt', 'x==1.0.0\n')
    const result = discoverSubprojects(rootDir, 3, ['scratch/**'])
    expect(result).toEqual(['service-a'])
  })

  it('returns an empty array when no independent subproject exists', () => {
    write('requirements.txt', 'requests==2.31.0\n')
    const result = discoverSubprojects(rootDir, 3, [])
    expect(result).toEqual([])
  })
})
