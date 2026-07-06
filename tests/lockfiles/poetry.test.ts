import { describe, it, expect } from 'vitest'
import { collectPoetryDependencyNames, resolvePoetryVersions } from '../../src/lockfiles/poetry'

describe('collectPoetryDependencyNames', () => {
  it('collects names from [tool.poetry.dependencies], skipping the python key', () => {
    const pyproject = `
[tool.poetry.dependencies]
python = "^3.10"
requests = "^2.31.0"
flask = "^3.0.0"
`
    expect(collectPoetryDependencyNames(pyproject).sort()).toEqual(['flask', 'requests'])
  })

  it('collects names from a table-form dependency value, ignoring the value contents', () => {
    const pyproject = `
[tool.poetry.dependencies]
python = "^3.10"
flask = { version = "^3.0.0", optional = true }
`
    expect(collectPoetryDependencyNames(pyproject)).toEqual(['flask'])
  })

  it('collects names from a [tool.poetry.group.<name>.dependencies] table', () => {
    const pyproject = `
[tool.poetry.dependencies]
python = "^3.10"
requests = "^2.31.0"

[tool.poetry.group.dev.dependencies]
pytest = "^8.0.0"
`
    expect(collectPoetryDependencyNames(pyproject).sort()).toEqual(['pytest', 'requests'])
  })

  it('collects names from a custom-named group table', () => {
    const pyproject = `
[tool.poetry.dependencies]
python = "^3.10"

[tool.poetry.group.test.dependencies]
pytest = "^8.0.0"
`
    expect(collectPoetryDependencyNames(pyproject)).toEqual(['pytest'])
  })

  it('collects names from the legacy [tool.poetry.dev-dependencies] table', () => {
    const pyproject = `
[tool.poetry.dependencies]
python = "^3.10"
requests = "^2.31.0"

[tool.poetry.dev-dependencies]
pytest = "^8.0.0"
`
    expect(collectPoetryDependencyNames(pyproject).sort()).toEqual(['pytest', 'requests'])
  })

  it('deduplicates a name appearing in two different groups', () => {
    const pyproject = `
[tool.poetry.dependencies]
python = "^3.10"
requests = "^2.31.0"

[tool.poetry.group.dev.dependencies]
requests = "^2.31.0"
`
    expect(collectPoetryDependencyNames(pyproject)).toEqual(['requests'])
  })
})

describe('resolvePoetryVersions', () => {
  it('resolves an exact-name match', () => {
    const lock = `
[[package]]
name = "requests"
version = "2.31.0"

[[package]]
name = "flask"
version = "3.0.0"
`
    const result = resolvePoetryVersions(lock, ['requests', 'flask'])
    expect(result.get('requests')).toBe('2.31.0')
    expect(result.get('flask')).toBe('3.0.0')
  })

  it('resolves a name differing only in case via PEP 503 normalization', () => {
    const lock = `
[[package]]
name = "PyYAML"
version = "6.0.1"
`
    const result = resolvePoetryVersions(lock, ['pyyaml'])
    expect(result.get('pyyaml')).toBe('6.0.1')
  })

  it('resolves a name differing in separator style via PEP 503 normalization', () => {
    const lock = `
[[package]]
name = "some_pkg"
version = "1.0.0"
`
    const result = resolvePoetryVersions(lock, ['some-pkg'])
    expect(result.get('some-pkg')).toBe('1.0.0')
  })

  it('does not include a name with no matching lock entry', () => {
    const lock = `
[[package]]
name = "requests"
version = "2.31.0"
`
    const result = resolvePoetryVersions(lock, ['requests', 'nonexistent-pkg'])
    expect(result.has('nonexistent-pkg')).toBe(false)
    expect(result.get('requests')).toBe('2.31.0')
  })
})
