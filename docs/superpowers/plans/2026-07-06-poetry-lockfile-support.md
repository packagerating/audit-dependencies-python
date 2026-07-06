# Poetry Lockfile Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic support for Poetry-managed Python projects (`pyproject.toml` +
`poetry.lock`) to `audit-dependencies-python`, alongside the existing `requirements.txt` support.

**Architecture:** A new `src/lockfiles/poetry.ts` module exposes two pure functions —
`collectPoetryDependencyNames` (parses `pyproject.toml`, returns dependency names) and
`resolvePoetryVersions` (parses `poetry.lock`, returns a name→version map for a given set of
names). `src/discover.ts`'s `discoverPackages` gains a detection branch: if `poetry.lock` exists
next to `requirements-path`, it calls both functions and merges the results instead of parsing
`requirements.txt`.

**Tech Stack:** TypeScript, `smol-toml` (new dependency, TOML 1.0.0 parser), `vitest`.

## Global Constraints

- Detection is automatic, keyed off `poetry.lock`'s presence in the same directory
  `requirements-path` resolves to (via `path.dirname(path.resolve(requirementsPath))`, matching
  `discoverPackages`'s existing path-resolution behavior) — no new required input.
- If `poetry.lock` is found: ignore `requirements.txt` entirely, read `pyproject.toml` (same
  directory) for names and `poetry.lock` for versions. If not found: fall back to today's
  `requirements.txt` parsing, completely unchanged.
- The explicit `packages` input (comma-separated override) bypasses both `requirements.txt` and
  Poetry parsing entirely, exactly as it does today — checked first, before any file-system
  detection happens.
- Dependency names are collected from THREE places in `pyproject.toml`, unconditionally, no
  separate include-dev flag: `[tool.poetry.dependencies]` (skipping the `python` key — a version
  constraint, not a package), every `[tool.poetry.group.<name>.dependencies]` table (any group
  name), and the legacy `[tool.poetry.dev-dependencies]` table if present. Names are deduplicated
  across all three sources.
- A dependency's TOML value can be a plain string (`"^2.31.0"`) or a table
  (`{version = "^3.0.0", optional = true}`) — only the key (name) is ever used; the value is never
  inspected.
- `poetry.lock`'s `[[package]]` array is a flat list covering every group together — no
  group-filtering happens when reading the lockfile; filtering already happened when collecting
  names from `pyproject.toml`.
- Package name matching between `pyproject.toml` and `poetry.lock` is case-insensitive with `-`,
  `_`, and `.` treated as equivalent (PEP 503 normalization: lowercase, then any of the three
  separator characters normalize to a single `-`) — e.g. `PyYAML` must match `pyyaml`, `some_pkg`
  must match `some-pkg`.
- Out of scope (do not implement): PDM (`pdm.lock`), uv (`uv.lock`), `Pipfile`/`Pipfile.lock`,
  Poetry's `optional`/extras-conditional inclusion (an optional dependency is still audited
  unconditionally).

---

### Task 1: Poetry parsing module (`src/lockfiles/poetry.ts`)

**Files:**
- Create: `src/lockfiles/poetry.ts`
- Test: `tests/lockfiles/poetry.test.ts`
- Modify: `package.json` (add `smol-toml` dependency)

**Interfaces:**
- Consumes: nothing from earlier tasks (self-contained; only Node's built-in nothing plus the new
  `smol-toml` package).
- Produces: `collectPoetryDependencyNames(pyprojectContent: string): string[]` and
  `resolvePoetryVersions(poetryLockContent: string, names: string[]): Map<string, string>` —
  both consumed by Task 2 (`src/discover.ts`).

- [ ] **Step 1: Add the `smol-toml` dependency**

Run: `npm install smol-toml@^1.7.0`

Expected: `package.json`'s `dependencies` gains `"smol-toml": "^1.7.0"`, `package-lock.json` updates.

- [ ] **Step 2: Write the failing tests**

```typescript
// tests/lockfiles/poetry.test.ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/lockfiles/poetry.test.ts`
Expected: FAIL — `src/lockfiles/poetry.ts` does not exist yet.

- [ ] **Step 4: Implement `src/lockfiles/poetry.ts`**

```typescript
import { parse } from 'smol-toml'

interface PyprojectToml {
  tool?: {
    poetry?: {
      dependencies?: Record<string, unknown>
      'dev-dependencies'?: Record<string, unknown>
      group?: Record<string, { dependencies?: Record<string, unknown> }>
    }
  }
}

interface PoetryLock {
  package?: Array<{ name?: string; version?: string }>
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

export function collectPoetryDependencyNames(pyprojectContent: string): string[] {
  const parsed = parse(pyprojectContent) as PyprojectToml
  const poetry = parsed.tool?.poetry
  const names = new Set<string>()

  for (const name of Object.keys(poetry?.dependencies ?? {})) {
    if (name === 'python') continue
    names.add(name)
  }

  for (const name of Object.keys(poetry?.['dev-dependencies'] ?? {})) {
    names.add(name)
  }

  for (const group of Object.values(poetry?.group ?? {})) {
    for (const name of Object.keys(group.dependencies ?? {})) {
      names.add(name)
    }
  }

  return [...names]
}

export function resolvePoetryVersions(poetryLockContent: string, names: string[]): Map<string, string> {
  const parsed = parse(poetryLockContent) as PoetryLock
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

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/lockfiles/poetry.test.ts`
Expected: PASS (10/10)

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/lockfiles/poetry.ts tests/lockfiles/poetry.test.ts
git commit -m "feat: add Poetry pyproject.toml/poetry.lock parsing"
```

---

### Task 2: Wire Poetry detection into `discoverPackages`

**Files:**
- Modify: `src/discover.ts`
- Test: `tests/discover.test.ts`

**Interfaces:**
- Consumes: `collectPoetryDependencyNames`, `resolvePoetryVersions` from `src/lockfiles/poetry.ts`
  (Task 1).
- Produces: `discoverPackages`'s existing exported signature is unchanged
  (`discoverPackages(requirementsPath: string, explicitPackages: string[]): DiscoveredPackage[]`)
  — this task only changes its internal behavior, not its interface. Nothing later in the plan
  depends on new exports from this task.

- [ ] **Step 1: Read the current `src/discover.ts` to confirm its exact shape**

Read `src/discover.ts` in full before editing — this task modifies the existing
`discoverPackages` function body, not its signature.

- [ ] **Step 2: Write the failing tests**

Add these test cases to `tests/discover.test.ts` (append to the existing `describe('discoverPackages', ...)` block — do not remove or modify any existing test in this file):

```typescript
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
```

These tests use the same `rootDir`/`write`/`beforeEach`/`afterEach` real-temp-directory fixture
already present at the top of `tests/discover.test.ts` — do not duplicate that setup, only add
the new `it(...)` blocks inside the existing `describe('discoverPackages', ...)` block.

- [ ] **Step 3: Run the tests to verify the four new ones fail**

Run: `npx vitest run tests/discover.test.ts`
Expected: FAIL on the 4 new tests (poetry.lock detection doesn't exist yet); all pre-existing tests
still PASS unmodified.

- [ ] **Step 4: Modify `src/discover.ts`**

Add the import at the top of the file, alongside the existing `fs`/`path` imports:

```typescript
import { collectPoetryDependencyNames, resolvePoetryVersions } from './lockfiles/poetry'
```

Replace the `discoverPackages` function body with:

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

  const all = parseFile(requirementsPath, new Set())

  const byName = new Map<string, DiscoveredPackage>()
  for (const pkg of all) byName.set(pkg.name, pkg)
  return [...byName.values()]
}
```

Do not change `parseFile`, `parseRequirementLine`, `isRequirementInclude`, or `isVcsOrUrl` — the
`requirements.txt` code path is untouched, only reached when `poetry.lock` is absent.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/discover.test.ts`
Expected: PASS (18/18 — 14 existing + 4 new).

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS across all test files (types, discover, lockfiles/poetry, score, report, index) —
zero regressions.

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
git commit -m "feat: detect and parse Poetry projects (pyproject.toml + poetry.lock)"
```
