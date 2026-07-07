import { describe, it, expect } from 'vitest'
import { collectUvDependencyNames, resolveUvVersions } from '../../src/lockfiles/uv'

describe('collectUvDependencyNames', () => {
  it('collects names from [project.dependencies]', () => {
    const pyproject = `
[project]
name = "myproj"
dependencies = ["requests>=2.31.0", "flask>=3.0.0"]
`
    expect(collectUvDependencyNames(pyproject).sort()).toEqual(['flask', 'requests'])
  })

  it('strips extras from a PEP 508 string, keeping only the name', () => {
    const pyproject = `
[project]
dependencies = ["flask[async]>=3.0.0"]
`
    expect(collectUvDependencyNames(pyproject)).toEqual(['flask'])
  })

  it('strips an environment marker from a PEP 508 string', () => {
    const pyproject = `
[project]
dependencies = ["requests>=2.31.0 ; python_version >= '3.8'"]
`
    expect(collectUvDependencyNames(pyproject)).toEqual(['requests'])
  })

  it('collects names from a [dependency-groups.dev] array', () => {
    const pyproject = `
[project]
dependencies = ["requests>=2.31.0"]

[dependency-groups]
dev = ["pytest>=8.0.0"]
`
    expect(collectUvDependencyNames(pyproject).sort()).toEqual(['pytest', 'requests'])
  })

  it('collects names from a custom-named dependency group', () => {
    const pyproject = `
[project]
dependencies = []

[dependency-groups]
test = ["pytest>=8.0.0"]
`
    expect(collectUvDependencyNames(pyproject)).toEqual(['pytest'])
  })

  it('collects names from the legacy [tool.uv.dev-dependencies] array', () => {
    const pyproject = `
[project]
dependencies = ["requests>=2.31.0"]

[tool.uv]
dev-dependencies = ["pytest>=8.0.0"]
`
    expect(collectUvDependencyNames(pyproject).sort()).toEqual(['pytest', 'requests'])
  })

  it('deduplicates a name appearing in two different sources', () => {
    const pyproject = `
[project]
dependencies = ["requests>=2.31.0"]

[dependency-groups]
dev = ["requests>=2.31.0"]
`
    expect(collectUvDependencyNames(pyproject)).toEqual(['requests'])
  })
})

describe('resolveUvVersions', () => {
  it('resolves an exact-name match', () => {
    const lock = `
[[package]]
name = "requests"
version = "2.31.0"

[[package]]
name = "flask"
version = "3.0.0"
`
    const result = resolveUvVersions(lock, ['requests', 'flask'])
    expect(result.get('requests')).toBe('2.31.0')
    expect(result.get('flask')).toBe('3.0.0')
  })

  it('resolves a name differing only in case via PEP 503 normalization', () => {
    const lock = `
[[package]]
name = "PyYAML"
version = "6.0.1"
`
    const result = resolveUvVersions(lock, ['pyyaml'])
    expect(result.get('pyyaml')).toBe('6.0.1')
  })

  it('resolves a name differing in separator style via PEP 503 normalization', () => {
    const lock = `
[[package]]
name = "some_pkg"
version = "1.0.0"
`
    const result = resolveUvVersions(lock, ['some-pkg'])
    expect(result.get('some-pkg')).toBe('1.0.0')
  })

  it('does not include a name with no matching lock entry', () => {
    const lock = `
[[package]]
name = "requests"
version = "2.31.0"
`
    const result = resolveUvVersions(lock, ['requests', 'nonexistent-pkg'])
    expect(result.has('nonexistent-pkg')).toBe(false)
    expect(result.get('requests')).toBe('2.31.0')
  })
})
