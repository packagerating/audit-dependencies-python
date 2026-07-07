# uv Lockfile Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic support for uv-managed Python projects (`pyproject.toml` + `uv.lock`) to
`audit-dependencies-python`, alongside the existing `requirements.txt`, Poetry, and Pipenv support.

**Architecture:** A new `src/lockfiles/uv.ts` module exposes two pure functions —
`collectUvDependencyNames` (parses `pyproject.toml`'s PEP 508 dependency-string arrays, returns
names) and `resolveUvVersions` (parses `uv.lock`'s flat package list, returns a name→version map
for a given set of names) — mirroring the existing `src/lockfiles/poetry.ts`'s two-function shape
exactly. `src/discover.ts`'s `discoverPackages` gains a new detection tier, inserted between the
existing `Pipfile.lock` check and the `requirements.txt` fallback.

**Tech Stack:** TypeScript, `smol-toml` (already a dependency, added for Poetry — no new
dependency needed), `vitest`.

## Global Constraints

- Detection order: `poetry.lock` (existing, unchanged, first) → `Pipfile.lock` (existing,
  unchanged) → `uv.lock` (new, checked third) → `requirements.txt` (existing, unchanged, final
  fallback). All checks look in the same directory `requirements-path` resolves to.
- The explicit `packages` input bypasses all four modes, checked first, before any file-system
  detection.
- Like Poetry, uv needs both `pyproject.toml` (for names) and `uv.lock` (for versions) — `uv.lock`
  alone isn't sufficient since its flat package list isn't filtered to what the project actually
  declares.
- Dependency names are collected from THREE places in `pyproject.toml`, unconditionally, no
  separate include-dev flag: `[project.dependencies]` (an array of PEP 508 requirement strings,
  e.g. `"requests>=2.31.0"` — NOT a table like Poetry's), every group in `[dependency-groups]`
  (any group name, PEP 735 standard — also arrays of PEP 508 strings), and the legacy
  `[tool.uv.dev-dependencies]` array. Deduplicated across all three sources.
- Extracting a name from a PEP 508 string: strip everything from the first `;` onward (an
  environment marker, never evaluated); extract the name as everything before the first `[`, `=`,
  `>`, `<`, `~`, or `!`, trimmed. Extras (`flask[async]>=3.0.0` → name `flask`) are stripped, not
  treated as part of the name.
- `uv.lock`'s `[[package]]` array is a flat list — no group-filtering happens when reading it;
  filtering already happened when collecting names from `pyproject.toml`.
- Package name matching between `pyproject.toml` and `uv.lock` is case-insensitive with `-`, `_`,
  `.` treated as equivalent (PEP 503 normalization — same rule already implemented for Poetry).
- Out of scope (do not implement): PDM (`pdm.lock`), uv workspaces (multiple `pyproject.toml`
  files sharing one root `uv.lock` — only the root project's own declarations are read).

---

### Task 1: uv parsing module (`src/lockfiles/uv.ts`)

**Files:**
- Create: `src/lockfiles/uv.ts`
- Test: `tests/lockfiles/uv.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (self-contained; uses the already-installed `smol-toml`
  package, no new dependency).
- Produces: `collectUvDependencyNames(pyprojectContent: string): string[]` and
  `resolveUvVersions(uvLockContent: string, names: string[]): Map<string, string>` — both
  consumed by Task 2 (`src/discover.ts`).

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lockfiles/uv.test.ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lockfiles/uv.test.ts`
Expected: FAIL — `src/lockfiles/uv.ts` does not exist yet.

- [ ] **Step 3: Implement `src/lockfiles/uv.ts`**

```typescript
import { parse } from 'smol-toml'

interface PyprojectToml {
  project?: {
    dependencies?: string[]
  }
  'dependency-groups'?: Record<string, string[]>
  tool?: {
    uv?: {
      'dev-dependencies'?: string[]
    }
  }
}

interface UvLock {
  package?: Array<{ name?: string; version?: string }>
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

function extractPackageName(requirementString: string): string | null {
  const withoutMarker = requirementString.split(';')[0]!.trim()
  if (!withoutMarker) return null

  const nameMatch = withoutMarker.match(/^([^[=><~!]+)/)
  if (!nameMatch) return null

  const name = nameMatch[1]!.trim()
  return name || null
}

export function collectUvDependencyNames(pyprojectContent: string): string[] {
  const parsed = parse(pyprojectContent) as PyprojectToml
  const names = new Set<string>()

  for (const req of parsed.project?.dependencies ?? []) {
    const name = extractPackageName(req)
    if (name) names.add(name)
  }

  for (const req of parsed.tool?.uv?.['dev-dependencies'] ?? []) {
    const name = extractPackageName(req)
    if (name) names.add(name)
  }

  for (const group of Object.values(parsed['dependency-groups'] ?? {})) {
    for (const req of group) {
      const name = extractPackageName(req)
      if (name) names.add(name)
    }
  }

  return [...names]
}

export function resolveUvVersions(uvLockContent: string, names: string[]): Map<string, string> {
  const parsed = parse(uvLockContent) as UvLock
  const byNormalizedName = new Map<string, string>()

  for (const pkg of parsed.package ?? []) {
    if (pkg.name && pkg.version) {
      byNormalizedName.set(normalizeName(pkg.name), pkg.version)
    }
  }

  const resolved = new Map<string, string>()
  for (const name of names) {
    const version = byNormalizedName.get(normalizeName(name))
    if (version) resolved.set(name, version)
  }

  return resolved
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lockfiles/uv.test.ts`
Expected: PASS (11/11)

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/lockfiles/uv.ts tests/lockfiles/uv.test.ts
git commit -m "feat: add uv pyproject.toml/uv.lock parsing"
```

---

### Task 2: Wire uv detection into `discoverPackages`

**Files:**
- Modify: `src/discover.ts`
- Test: `tests/discover.test.ts`

**Interfaces:**
- Consumes: `collectUvDependencyNames`, `resolveUvVersions` from `src/lockfiles/uv.ts` (Task 1).
- Produces: `discoverPackages`'s existing exported signature is unchanged
  (`discoverPackages(requirementsPath: string, explicitPackages: string[]): DiscoveredPackage[]`)
  — this task only changes its internal behavior, not its interface.

- [ ] **Step 1: Read the current `src/discover.ts` to confirm its exact shape**

Read `src/discover.ts` in full before editing. It currently has, in order: an explicit-packages
early return, a `poetry.lock` detection branch, a `Pipfile.lock` detection branch, then the
`requirements.txt` fallback. This task inserts a new `uv.lock` branch between the `Pipfile.lock`
branch and the `requirements.txt` fallback — the `poetry.lock` and `Pipfile.lock` branches must
remain completely unchanged.

- [ ] **Step 2: Write the failing tests**

Add these test cases to `tests/discover.test.ts` (append to the existing
`describe('discoverPackages', ...)` block — do not remove or modify any existing test in this
file):

```typescript
  it('uses uv mode when uv.lock exists, ignoring requirements.txt entirely', () => {
    write('requirements.txt', 'this-should-be-ignored==9.9.9\n')
    write(
      'pyproject.toml',
      `
[project]
dependencies = ["requests>=2.31.0"]
`,
    )
    write(
      'uv.lock',
      `
[[package]]
name = "requests"
version = "2.31.0"
`,
    )
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result).toEqual([{ name: 'requests', version: '2.31.0' }])
  })

  it('prefers Pipenv mode over uv mode when both Pipfile.lock and uv.lock exist', () => {
    write(
      'Pipfile.lock',
      JSON.stringify({
        default: {
          flask: { hashes: ['sha256:abc'], version: '==3.0.0' },
        },
      }),
    )
    write(
      'pyproject.toml',
      `
[project]
dependencies = ["requests>=2.31.0"]
`,
    )
    write(
      'uv.lock',
      `
[[package]]
name = "requests"
version = "2.31.0"
`,
    )
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result).toEqual([{ name: 'flask', version: '3.0.0' }])
  })

  it('still bypasses requirements.txt, Poetry, Pipenv, and uv parsing when explicit packages are given', () => {
    write('Pipfile.lock', JSON.stringify({ default: { flask: { version: '==3.0.0' } } }))
    write('pyproject.toml', '[project]\ndependencies = ["requests>=2.31.0"]\n')
    write('uv.lock', '[[package]]\nname = "requests"\nversion = "2.31.0"\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), ['django'])
    expect(result).toEqual([{ name: 'django', version: null }])
  })
```

These tests use the same `rootDir`/`write`/`beforeEach`/`afterEach` real-temp-directory fixture
already present at the top of `tests/discover.test.ts` — do not duplicate that setup, only add
the new `it(...)` blocks inside the existing `describe('discoverPackages', ...)` block.

- [ ] **Step 3: Run the tests to verify the three new ones fail**

Run: `npx vitest run tests/discover.test.ts`
Expected: FAIL on the 3 new tests (`uv.lock` detection doesn't exist yet); all pre-existing tests
still PASS unmodified.

- [ ] **Step 4: Modify `src/discover.ts`**

Add the import at the top of the file, alongside the existing `poetry`/`pipenv` imports:

```typescript
import { collectUvDependencyNames, resolveUvVersions } from './lockfiles/uv'
```

In `discoverPackages`, insert a new branch between the existing `Pipfile.lock` block and the
`requirements.txt` fallback:

```typescript
export function discoverPackages(requirementsPath: string, explicitPackages: string[]): DiscoveredPackage[] {
  if (explicitPackages.length > 0) {
    return [...new Set(explicitPackages)].map(name => ({ name, version: null }))
  }

  const resolvedRequirementsPath = path.resolve(requirementsPath)
  const dir = path.dirname(resolvedRequirementsPath)
  const poetryLockPath = path.join(dir, 'poetry.lock')

  if (fs.existsSync(poetryLockPath)) {
    const pyprojectPath = path.join(dir, 'pyproject.toml')
    const names = collectPoetryDependencyNames(fs.readFileSync(pyprojectPath, 'utf8'))
    const versions = resolvePoetryVersions(fs.readFileSync(poetryLockPath, 'utf8'), names)
    return names.map(name => ({ name, version: versions.get(name) ?? null }))
  }

  const pipfileLockPath = path.join(dir, 'Pipfile.lock')
  if (fs.existsSync(pipfileLockPath)) {
    return parsePipfileLock(fs.readFileSync(pipfileLockPath, 'utf8'))
  }

  const uvLockPath = path.join(dir, 'uv.lock')
  if (fs.existsSync(uvLockPath)) {
    const pyprojectPath = path.join(dir, 'pyproject.toml')
    const names = collectUvDependencyNames(fs.readFileSync(pyprojectPath, 'utf8'))
    const versions = resolveUvVersions(fs.readFileSync(uvLockPath, 'utf8'), names)
    return names.map(name => ({ name, version: versions.get(name) ?? null }))
  }

  const all = parseFile(requirementsPath, new Set())

  const byName = new Map<string, DiscoveredPackage>()
  for (const pkg of all) byName.set(pkg.name, pkg)
  return [...byName.values()]
}
```

Do not change `parseFile`, `parseRequirementLine`, `isRequirementInclude`, `isVcsOrUrl`, the
existing Poetry branch, or the existing Pipenv branch — only the new `uv.lock` branch is
inserted, between the Pipenv branch and the `requirements.txt` fallback.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/discover.test.ts`
Expected: PASS (24/24 — 21 existing + 3 new).

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS across all test files (types, discover, lockfiles/poetry, lockfiles/pipenv,
lockfiles/uv, score, report, index) — zero regressions.

- [ ] **Step 8: Run the production build**

Run: `npm run build`
Expected: succeeds, produces `dist/index.js`.

- [ ] **Step 9: Revert the verification build artifact**

```bash
git checkout -- dist/index.js 2>/dev/null || rm -rf dist
git status --short
```

Expected: no unexpected modifications remain (only untracked scratch directories, if present, are
acceptable).

- [ ] **Step 10: Commit**

```bash
git add src/discover.ts tests/discover.test.ts
git commit -m "feat: detect and parse uv projects (pyproject.toml + uv.lock)"
```
