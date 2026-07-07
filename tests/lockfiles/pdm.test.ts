import { describe, it, expect } from 'vitest'
import { collectPdmDependencyNames, resolvePdmVersions } from '../../src/lockfiles/pdm'

describe('collectPdmDependencyNames', () => {
  it('collects names from [project.dependencies]', () => {
    const pyproject = `
[project]
name = "myproj"
dependencies = ["requests>=2.31.0", "flask>=3.0.0"]
`
    expect(collectPdmDependencyNames(pyproject).sort()).toEqual(['flask', 'requests'])
  })

  it('strips extras from a PEP 508 string, keeping only the name', () => {
    const pyproject = `
[project]
dependencies = ["flask[async]>=3.0.0"]
`
    expect(collectPdmDependencyNames(pyproject)).toEqual(['flask'])
  })

  it('strips an environment marker from a PEP 508 string', () => {
    const pyproject = `
[project]
dependencies = ["requests>=2.31.0 ; python_version >= '3.8'"]
`
    expect(collectPdmDependencyNames(pyproject)).toEqual(['requests'])
  })

  it('collects names from a [dependency-groups.dev] array', () => {
    const pyproject = `
[project]
dependencies = ["requests>=2.31.0"]

[dependency-groups]
dev = ["pytest>=8.0.0"]
`
    expect(collectPdmDependencyNames(pyproject).sort()).toEqual(['pytest', 'requests'])
  })

  it('collects names from a custom-named [dependency-groups] entry', () => {
    const pyproject = `
[project]
dependencies = []

[dependency-groups]
test = ["pytest>=8.0.0"]
`
    expect(collectPdmDependencyNames(pyproject)).toEqual(['pytest'])
  })

  it('collects names from a named group in [tool.pdm.dev-dependencies]', () => {
    const pyproject = `
[project]
dependencies = ["requests>=2.31.0"]

[tool.pdm.dev-dependencies]
test = ["pytest>=8.0.0"]
`
    expect(collectPdmDependencyNames(pyproject).sort()).toEqual(['pytest', 'requests'])
  })

  it('collects names from a DIFFERENT custom-named group in [tool.pdm.dev-dependencies]', () => {
    const pyproject = `
[project]
dependencies = []

[tool.pdm.dev-dependencies]
lint = ["ruff>=0.1.0"]
`
    expect(collectPdmDependencyNames(pyproject)).toEqual(['ruff'])
  })

  it('deduplicates a name appearing in two different sources', () => {
    const pyproject = `
[project]
dependencies = ["requests>=2.31.0"]

[tool.pdm.dev-dependencies]
test = ["requests>=2.31.0"]
`
    expect(collectPdmDependencyNames(pyproject)).toEqual(['requests'])
  })
})

describe('resolvePdmVersions', () => {
  it('resolves an exact-name match', () => {
    const lock = `
[[package]]
name = "requests"
version = "2.31.0"

[[package]]
name = "flask"
version = "3.0.0"
`
    const result = resolvePdmVersions(lock, ['requests', 'flask'])
    expect(result.get('requests')).toBe('2.31.0')
    expect(result.get('flask')).toBe('3.0.0')
  })

  it('resolves a name differing only in case via PEP 503 normalization', () => {
    const lock = `
[[package]]
name = "PyYAML"
version = "6.0.1"
`
    const result = resolvePdmVersions(lock, ['pyyaml'])
    expect(result.get('pyyaml')).toBe('6.0.1')
  })

  it('resolves a name differing in separator style via PEP 503 normalization', () => {
    const lock = `
[[package]]
name = "some_pkg"
version = "1.0.0"
`
    const result = resolvePdmVersions(lock, ['some-pkg'])
    expect(result.get('some-pkg')).toBe('1.0.0')
  })

  it('does not include a name with no matching lock entry', () => {
    const lock = `
[[package]]
name = "requests"
version = "2.31.0"
`
    const result = resolvePdmVersions(lock, ['requests', 'nonexistent-pkg'])
    expect(result.has('nonexistent-pkg')).toBe(false)
    expect(result.get('requests')).toBe('2.31.0')
  })
})
