# Pipenv Lockfile Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic support for Pipenv-managed Python projects (`Pipfile.lock`) to
`audit-dependencies-python`, alongside the existing `requirements.txt` and Poetry support.

**Architecture:** A new `src/lockfiles/pipenv.ts` module exposes one pure function —
`parsePipfileLock` — that parses `Pipfile.lock` (JSON) directly into the final
`DiscoveredPackage[]` result, since (unlike Poetry) a single lockfile already contains both names
and resolved versions. `src/discover.ts`'s `discoverPackages` gains a new detection tier between
the existing `poetry.lock` check and the `requirements.txt` fallback.

**Tech Stack:** TypeScript, built-in `JSON.parse` (no new dependency — `Pipfile.lock` is JSON, not
TOML), `vitest`.

## Global Constraints

- Detection order: `poetry.lock` (existing, unchanged, checked first) → `Pipfile.lock` (new,
  checked second) → `requirements.txt` (existing, unchanged, final fallback). All checks look in
  the same directory `requirements-path` resolves to.
- The explicit `packages` input bypasses all three modes, checked first, before any file-system
  detection — exactly as it does today.
- `Pipfile` itself is never read — `Pipfile.lock` alone contains both dependency names and
  resolved versions in its `default` (production) and `develop` (dev) sections, both read
  unconditionally (no separate include-dev flag).
- Each package entry's `version` field is a string prefixed with `==` (e.g. `"==2.31.0"`) — must
  be stripped to the bare version.
- A package entry with no `version` field at all (editable/VCS/local-path dependency) is skipped
  entirely — not included with a null version.
- A package name appearing in both `default` and `develop` is deduplicated to one entry; if the
  two sections ever disagree on version, `default`'s version wins (a deterministic tie-break, not
  expected to occur in a correctly generated lockfile).
- Out of scope (do not implement): custom Pipenv dependency categories beyond `default`/`develop`,
  PDM (`pdm.lock`), uv (`uv.lock`).

---

### Task 1: Pipenv parsing module (`src/lockfiles/pipenv.ts`)

**Files:**
- Create: `src/lockfiles/pipenv.ts`
- Test: `tests/lockfiles/pipenv.test.ts`

**Interfaces:**
- Consumes: `DiscoveredPackage` type from `src/discover.ts` (type-only import — no circular
  runtime dependency, since `discover.ts` will import a *function* from this file in Task 2, while
  this file only imports a *type* from `discover.ts`).
- Produces: `parsePipfileLock(pipfileLockContent: string): DiscoveredPackage[]` — consumed by
  Task 2 (`src/discover.ts`).

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lockfiles/pipenv.test.ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lockfiles/pipenv.test.ts`
Expected: FAIL — `src/lockfiles/pipenv.ts` does not exist yet.

- [ ] **Step 3: Implement `src/lockfiles/pipenv.ts`**

```typescript
import type { DiscoveredPackage } from '../discover'

interface PipfileLockPackage {
  version?: string
}

interface PipfileLock {
  default?: Record<string, PipfileLockPackage>
  develop?: Record<string, PipfileLockPackage>
}

export function parsePipfileLock(pipfileLockContent: string): DiscoveredPackage[] {
  const parsed = JSON.parse(pipfileLockContent) as PipfileLock
  const byName = new Map<string, DiscoveredPackage>()

  for (const [name, pkg] of Object.entries(parsed.develop ?? {})) {
    if (!pkg.version) continue
    byName.set(name, { name, version: pkg.version.replace(/^==/, '') })
  }

  for (const [name, pkg] of Object.entries(parsed.default ?? {})) {
    if (!pkg.version) continue
    byName.set(name, { name, version: pkg.version.replace(/^==/, '') })
  }

  return [...byName.values()]
}
```

`develop` is processed first, `default` second — since `Map.set` on an existing key overwrites the
value, this ordering makes `default`'s version win whenever the same name appears in both
sections, matching the Global Constraints' tie-break rule.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lockfiles/pipenv.test.ts`
Expected: PASS (4/4)

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/lockfiles/pipenv.ts tests/lockfiles/pipenv.test.ts
git commit -m "feat: add Pipfile.lock parsing"
```

---

### Task 2: Wire Pipenv detection into `discoverPackages`

**Files:**
- Modify: `src/discover.ts`
- Test: `tests/discover.test.ts`

**Interfaces:**
- Consumes: `parsePipfileLock` from `src/lockfiles/pipenv.ts` (Task 1).
- Produces: `discoverPackages`'s existing exported signature is unchanged
  (`discoverPackages(requirementsPath: string, explicitPackages: string[]): DiscoveredPackage[]`)
  — this task only changes its internal behavior, not its interface.

- [ ] **Step 1: Read the current `src/discover.ts` to confirm its exact shape**

Read `src/discover.ts` in full before editing — this task modifies the existing
`discoverPackages` function body, not its signature. It currently has a `poetry.lock` detection
branch (added in a prior plan) that must remain unchanged; you are only inserting a new branch
between it and the `requirements.txt` fallback.

- [ ] **Step 2: Write the failing tests**

Add these test cases to `tests/discover.test.ts` (append to the existing
`describe('discoverPackages', ...)` block — do not remove or modify any existing test in this
file):

```typescript
  it('uses Pipenv mode when Pipfile.lock exists, ignoring requirements.txt entirely', () => {
    write('requirements.txt', 'this-should-be-ignored==9.9.9\n')
    write(
      'Pipfile.lock',
      JSON.stringify({
        default: {
          requests: { hashes: ['sha256:abc'], version: '==2.31.0' },
        },
      }),
    )
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result).toEqual([{ name: 'requests', version: '2.31.0' }])
  })

  it('prefers Poetry mode over Pipenv mode when both poetry.lock and Pipfile.lock exist', () => {
    write(
      'pyproject.toml',
      `
[tool.poetry.dependencies]
python = "^3.10"
flask = "^3.0.0"
`,
    )
    write(
      'poetry.lock',
      `
[[package]]
name = "flask"
version = "3.0.0"
`,
    )
    write(
      'Pipfile.lock',
      JSON.stringify({
        default: {
          requests: { hashes: ['sha256:abc'], version: '==2.31.0' },
        },
      }),
    )
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result).toEqual([{ name: 'flask', version: '3.0.0' }])
  })

  it('still bypasses requirements.txt, Poetry, and Pipenv parsing when explicit packages are given', () => {
    write('poetry.lock', '[[package]]\nname = "flask"\nversion = "3.0.0"\n')
    write('pyproject.toml', '[tool.poetry.dependencies]\npython = "^3.10"\n')
    write('Pipfile.lock', JSON.stringify({ default: { requests: { version: '==2.31.0' } } }))
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), ['django'])
    expect(result).toEqual([{ name: 'django', version: null }])
  })
```

These tests use the same `rootDir`/`write`/`beforeEach`/`afterEach` real-temp-directory fixture
already present at the top of `tests/discover.test.ts` — do not duplicate that setup, only add
the new `it(...)` blocks inside the existing `describe('discoverPackages', ...)` block.

- [ ] **Step 3: Run the tests to verify the three new ones fail**

Run: `npx vitest run tests/discover.test.ts`
Expected: FAIL on the 3 new tests (`Pipfile.lock` detection doesn't exist yet); all pre-existing
tests still PASS unmodified.

- [ ] **Step 4: Modify `src/discover.ts`**

Add the import at the top of the file, alongside the existing `poetry` import:

```typescript
import { parsePipfileLock } from './lockfiles/pipenv'
```

In `discoverPackages`, insert a new branch between the existing `poetry.lock` block and the
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

  const all = parseFile(requirementsPath, new Set())

  const byName = new Map<string, DiscoveredPackage>()
  for (const pkg of all) byName.set(pkg.name, pkg)
  return [...byName.values()]
}
```

Do not change `parseFile`, `parseRequirementLine`, `isRequirementInclude`, `isVcsOrUrl`, or the
existing Poetry branch — only the new `Pipfile.lock` branch is inserted, between the Poetry branch
and the `requirements.txt` fallback.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/discover.test.ts`
Expected: PASS (21/21 — 18 existing + 3 new).

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS across all test files (types, discover, lockfiles/poetry, lockfiles/pipenv, score,
report, index) — zero regressions.

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
git commit -m "feat: detect and parse Pipenv projects (Pipfile.lock)"
```
