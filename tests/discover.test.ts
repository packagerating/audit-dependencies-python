import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { discoverPackages } from '../src/discover'

let rootDir: string

function write(relPath: string, content: string) {
  const full = path.join(rootDir, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-python-'))
})

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true })
})

describe('discoverPackages', () => {
  it('resolves an exact == pin to that version', () => {
    write('requirements.txt', 'requests==2.31.0\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result).toEqual([{ name: 'requests', version: '2.31.0' }])
  })

  it('falls back to unversioned for a range constraint', () => {
    write('requirements.txt', 'requests>=2.0,<3.0\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result).toEqual([{ name: 'requests', version: null }])
  })

  it('falls back to unversioned for a compatible-release pin', () => {
    write('requirements.txt', 'requests~=2.31\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result).toEqual([{ name: 'requests', version: null }])
  })

  it('falls back to unversioned for a bare name with no constraint', () => {
    write('requirements.txt', 'requests\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result).toEqual([{ name: 'requests', version: null }])
  })

  it('strips extras from the name without affecting version resolution', () => {
    write('requirements.txt', 'requests[security]==2.31.0\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result).toEqual([{ name: 'requests', version: '2.31.0' }])
  })

  it('skips comment and blank lines', () => {
    write('requirements.txt', '# a comment\n\nrequests==2.31.0\n\n# another\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result).toEqual([{ name: 'requests', version: '2.31.0' }])
  })

  it('follows a -r include, resolved relative to the including file', () => {
    write('requirements/base.txt', 'requests==2.31.0\n')
    write('requirements.txt', '-r requirements/base.txt\nlodash==4.17.21\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'lodash', version: '4.17.21' },
      { name: 'requests', version: '2.31.0' },
    ])
  })

  it('follows a two-level --requirement chain', () => {
    write('requirements/base.txt', 'requests==2.31.0\n')
    write('requirements/dev.txt', '--requirement base.txt\npytest==8.0.0\n')
    write('requirements.txt', '-r requirements/dev.txt\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'pytest', version: '8.0.0' },
      { name: 'requests', version: '2.31.0' },
    ])
  })

  it('follows a --requirement=<path> include (equals-sign form)', () => {
    write('requirements/base.txt', 'requests==2.31.0\n')
    write('requirements.txt', '--requirement=requirements/base.txt\nlodash==4.17.21\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'lodash', version: '4.17.21' },
      { name: 'requests', version: '2.31.0' },
    ])
  })

  it('skips other pip option flags', () => {
    write('requirements.txt', '-e .\n--index-url https://example.com/simple\nrequests==2.31.0\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result).toEqual([{ name: 'requests', version: '2.31.0' }])
  })

  it('skips VCS and URL requirements', () => {
    write(
      'requirements.txt',
      'git+https://github.com/psf/requests.git@main#egg=requests\nhttps://example.com/pkg.whl\nrequests==2.31.0\n',
    )
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result).toEqual([{ name: 'requests', version: '2.31.0' }])
  })

  it('strips an environment marker without affecting inclusion', () => {
    write('requirements.txt', 'requests==2.31.0 ; python_version >= "3.8"\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result).toEqual([{ name: 'requests', version: '2.31.0' }])
  })

  it('does not read requirements.txt at all when explicit packages are given', () => {
    write('requirements.txt', 'requests==2.31.0\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), ['flask', 'django'])
    expect(result.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'django', version: null },
      { name: 'flask', version: null },
    ])
  })

  it('throws if requirements.txt is missing and no explicit packages are given', () => {
    expect(() => discoverPackages(path.join(rootDir, 'requirements.txt'), [])).toThrow()
  })

  it('uses Poetry mode when poetry.lock exists, ignoring requirements.txt entirely', () => {
    write('requirements.txt', 'this-should-be-ignored==9.9.9\n')
    write(
      'pyproject.toml',
      `
[tool.poetry.dependencies]
python = "^3.10"
requests = "^2.31.0"
`,
    )
    write(
      'poetry.lock',
      `
[[package]]
name = "requests"
version = "2.31.0"
`,
    )
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result).toEqual([{ name: 'requests', version: '2.31.0' }])
  })

  it('falls back to requirements.txt mode when poetry.lock does not exist', () => {
    write('requirements.txt', 'requests==2.31.0\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result).toEqual([{ name: 'requests', version: '2.31.0' }])
  })

  it('collects Poetry dependency names across the main table and a dev group', () => {
    write(
      'pyproject.toml',
      `
[tool.poetry.dependencies]
python = "^3.10"
requests = "^2.31.0"

[tool.poetry.group.dev.dependencies]
pytest = "^8.0.0"
`,
    )
    write(
      'poetry.lock',
      `
[[package]]
name = "requests"
version = "2.31.0"

[[package]]
name = "pytest"
version = "8.0.0"
`,
    )
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'pytest', version: '8.0.0' },
      { name: 'requests', version: '2.31.0' },
    ])
  })

  it('still bypasses both requirements.txt and Poetry parsing when explicit packages are given', () => {
    write('poetry.lock', '[[package]]\nname = "requests"\nversion = "2.31.0"\n')
    write('pyproject.toml', '[tool.poetry.dependencies]\npython = "^3.10"\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), ['flask'])
    expect(result).toEqual([{ name: 'flask', version: null }])
  })
})
