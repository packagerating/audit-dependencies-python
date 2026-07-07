# PDM Lockfile Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic support for PDM-managed Python projects (`pyproject.toml` + `pdm.lock`) to
`audit-dependencies-python`, alongside the existing `requirements.txt`, Poetry, Pipenv, and uv
support — completing Python dependency-manager coverage for this action.

**Architecture:** A new `src/lockfiles/pdm.ts` module exposes two pure functions —
`collectPdmDependencyNames` and `resolvePdmVersions` — mirroring `src/lockfiles/uv.ts`'s shape
closely, with one real structural difference: PDM's legacy dev-dependency syntax
(`[tool.pdm.dev-dependencies]`) is a *table of named groups* (like Poetry's), not a flat array
(like uv's `[tool.uv.dev-dependencies]`). `src/discover.ts`'s `discoverPackages` gains a new
detection tier, inserted between the existing `uv.lock` check and the `requirements.txt`
fallback.

**Tech Stack:** TypeScript, `smol-toml` (already a dependency — no new dependency needed),
`vitest`.

## Global Constraints

- Detection order: `poetry.lock` (existing, unchanged, first) → `Pipfile.lock` (existing,
  unchanged) → `uv.lock` (existing, unchanged) → `pdm.lock` (new, checked fourth) →
  `requirements.txt` (existing, unchanged, final fallback). All checks look in the same directory
  `requirements-path` resolves to.
- The explicit `packages` input bypasses all five modes, checked first, before any file-system
  detection.
- Like Poetry and uv, PDM needs both `pyproject.toml` (for names) and `pdm.lock` (for versions).
- Dependency names are collected from THREE places in `pyproject.toml`, unconditionally, no
  separate include-dev flag:
  1. `[project.dependencies]` — an array of PEP 508 requirement strings (same format as uv's).
  2. Every group in `[dependency-groups]`, for any group name — the shared PEP 735 standard
     (also used by uv).
  3. **`[tool.pdm.dev-dependencies]`** — PDM's own legacy table, mapping ANY group name to an
     array of PEP 508 requirement strings (e.g. `test = ["pytest>=8.0.0"]`, `lint = [...]`). This
     is a TABLE OF GROUPS, structurally like `[dependency-groups]` itself — NOT a flat array like
     uv's `[tool.uv.dev-dependencies]`. Get this distinction right: iterate
     `Object.values(parsed.tool?.pdm?.['dev-dependencies'] ?? {})`, then iterate each group's
     array — do not treat it as a single flat array.
  Deduplicated across all three sources.
- Extracting a name from a PEP 508 string: strip everything from the first `;` onward (an
  environment marker, never evaluated); extract the name as everything before the first `[`, `=`,
  `>`, `<`, `~`, or `!`, trimmed. Extras are stripped, not treated as part of the name. (Identical
  logic to `src/lockfiles/uv.ts`'s `extractPackageName`.)
- `pdm.lock`'s `[[package]]` array is a flat list (each entry also carries extra fields like
  `groups`, `requires_python`, `summary`, `files` — none of which are needed, only `name`/
  `version`) — no group-filtering happens when reading it; filtering already happened when
  collecting names from `pyproject.toml`.
- Package name matching between `pyproject.toml` and `pdm.lock` is case-insensitive with `-`, `_`,
  `.` treated as equivalent (PEP 503 normalization — same rule already implemented for Poetry/uv).
- Out of scope: this completes Python dependency-manager coverage — no further Python lockfile
  formats are planned. PDM/uv workspaces (multiple `pyproject.toml` files sharing one root
  lockfile) are not handled.

---

### Task 1: PDM parsing module (`src/lockfiles/pdm.ts`)

**Files:**
- Create: `src/lockfiles/pdm.ts`
- Test: `tests/lockfiles/pdm.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (self-contained; uses the already-installed `smol-toml`
  package, no new dependency).
- Produces: `collectPdmDependencyNames(pyprojectContent: string): string[]` and
  `resolvePdmVersions(pdmLockContent: string, names: string[]): Map<string, string>` — both
  consumed by Task 2 (`src/discover.ts`).

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lockfiles/pdm.test.ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lockfiles/pdm.test.ts`
Expected: FAIL — `src/lockfiles/pdm.ts` does not exist yet.

- [ ] **Step 3: Implement `src/lockfiles/pdm.ts`**

```typescript
import { parse } from 'smol-toml'

interface PyprojectToml {
  project?: {
    dependencies?: string[]
  }
  'dependency-groups'?: Record<string, string[]>
  tool?: {
    pdm?: {
      'dev-dependencies'?: Record<string, string[]>
    }
  }
}

interface PdmLock {
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

export function collectPdmDependencyNames(pyprojectContent: string): string[] {
  const parsed = parse(pyprojectContent) as PyprojectToml
  const names = new Set<string>()

  for (const req of parsed.project?.dependencies ?? []) {
    const name = extractPackageName(req)
    if (name) names.add(name)
  }

  for (const group of Object.values(parsed['dependency-groups'] ?? {})) {
    for (const req of group) {
      const name = extractPackageName(req)
      if (name) names.add(name)
    }
  }

  for (const group of Object.values(parsed.tool?.pdm?.['dev-dependencies'] ?? {})) {
    for (const req of group) {
      const name = extractPackageName(req)
      if (name) names.add(name)
    }
  }

  return [...names]
}

export function resolvePdmVersions(pdmLockContent: string, names: string[]): Map<string, string> {
  const parsed = parse(pdmLockContent) as PdmLock
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

Run: `npx vitest run tests/lockfiles/pdm.test.ts`
Expected: PASS (12/12)

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/lockfiles/pdm.ts tests/lockfiles/pdm.test.ts
git commit -m "feat: add PDM pyproject.toml/pdm.lock parsing"
```

---

### Task 2: Wire PDM detection into `discoverPackages`

**Files:**
- Modify: `src/discover.ts`
- Test: `tests/discover.test.ts`

**Interfaces:**
- Consumes: `collectPdmDependencyNames`, `resolvePdmVersions` from `src/lockfiles/pdm.ts`
  (Task 1).
- Produces: `discoverPackages`'s existing exported signature is unchanged
  (`discoverPackages(requirementsPath: string, explicitPackages: string[]): DiscoveredPackage[]`)
  — this task only changes its internal behavior, not its interface.

- [ ] **Step 1: Read the current `src/discover.ts` to confirm its exact shape**

Read `src/discover.ts` in full before editing. It currently has, in order: an explicit-packages
early return, a `poetry.lock` branch, a `Pipfile.lock` branch, a `uv.lock` branch, then the
`requirements.txt` fallback. This task inserts a new `pdm.lock` branch between the `uv.lock`
branch and the `requirements.txt` fallback — the `poetry.lock`, `Pipfile.lock`, and `uv.lock`
branches must remain completely unchanged.

- [ ] **Step 2: Write the failing tests**

Add these test cases to `tests/discover.test.ts` (append to the existing
`describe('discoverPackages', ...)` block — do not remove or modify any existing test in this
file):

```typescript
  it('uses PDM mode when pdm.lock exists, ignoring requirements.txt entirely', () => {
    write('requirements.txt', 'this-should-be-ignored==9.9.9\n')
    write(
      'pyproject.toml',
      `
[project]
dependencies = ["requests>=2.31.0"]
`,
    )
    write(
      'pdm.lock',
      `
[[package]]
name = "requests"
version = "2.31.0"
`,
    )
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result).toEqual([{ name: 'requests', version: '2.31.0' }])
  })

  it('prefers Poetry mode over PDM mode when both poetry.lock and pdm.lock exist', () => {
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
      'pdm.lock',
      `
[[package]]
name = "requests"
version = "2.31.0"
`,
    )
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result).toEqual([{ name: 'flask', version: '3.0.0' }])
  })

  it('prefers Pipenv mode over PDM mode when both Pipfile.lock and pdm.lock exist', () => {
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
      'pdm.lock',
      `
[[package]]
name = "requests"
version = "2.31.0"
`,
    )
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result).toEqual([{ name: 'flask', version: '3.0.0' }])
  })

  it('prefers uv mode over PDM mode when both uv.lock and pdm.lock exist', () => {
    write(
      'pyproject.toml',
      `
[project]
dependencies = ["flask>=3.0.0"]
`,
    )
    write(
      'uv.lock',
      `
[[package]]
name = "flask"
version = "3.0.0"
`,
    )
    write(
      'pdm.lock',
      `
[[package]]
name = "requests"
version = "2.31.0"
`,
    )
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [])
    expect(result).toEqual([{ name: 'flask', version: '3.0.0' }])
  })

  it('still bypasses requirements.txt, Poetry, Pipenv, uv, and PDM parsing when explicit packages are given', () => {
    write('Pipfile.lock', JSON.stringify({ default: { flask: { version: '==3.0.0' } } }))
    write('pyproject.toml', '[project]\ndependencies = ["requests>=2.31.0"]\n')
    write('uv.lock', '[[package]]\nname = "requests"\nversion = "2.31.0"\n')
    write('pdm.lock', '[[package]]\nname = "requests"\nversion = "2.31.0"\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), ['django'])
    expect(result).toEqual([{ name: 'django', version: null }])
  })
```

These tests use the same `rootDir`/`write`/`beforeEach`/`afterEach` real-temp-directory fixture
already present at the top of `tests/discover.test.ts` — do not duplicate that setup, only add
the new `it(...)` blocks inside the existing `describe('discoverPackages', ...)` block. Note that
the "prefers uv mode over PDM mode" test's `pyproject.toml` uses PEP 508 array syntax (uv's
format) since that's what `collectUvDependencyNames` reads when uv mode is (correctly) chosen —
`pdm.lock`'s content is irrelevant in that scenario since PDM mode should never be reached.

- [ ] **Step 3: Run the tests to verify the five new ones fail**

Run: `npx vitest run tests/discover.test.ts`
Expected: FAIL on the 5 new tests (`pdm.lock` detection doesn't exist yet); all pre-existing tests
still PASS unmodified.

- [ ] **Step 4: Modify `src/discover.ts`**

Add the import at the top of the file, alongside the existing `poetry`/`pipenv`/`uv` imports:

```typescript
import { collectPdmDependencyNames, resolvePdmVersions } from './lockfiles/pdm'
```

In `discoverPackages`, insert a new branch between the existing `uv.lock` block and the
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

  const pdmLockPath = path.join(dir, 'pdm.lock')
  if (fs.existsSync(pdmLockPath)) {
    const pyprojectPath = path.join(dir, 'pyproject.toml')
    const names = collectPdmDependencyNames(fs.readFileSync(pyprojectPath, 'utf8'))
    const versions = resolvePdmVersions(fs.readFileSync(pdmLockPath, 'utf8'), names)
    return names.map(name => ({ name, version: versions.get(name) ?? null }))
  }

  const all = parseFile(requirementsPath, new Set())

  const byName = new Map<string, DiscoveredPackage>()
  for (const pkg of all) byName.set(pkg.name, pkg)
  return [...byName.values()]
}
```

Do not change `parseFile`, `parseRequirementLine`, `isRequirementInclude`, `isVcsOrUrl`, the
existing Poetry branch, the existing Pipenv branch, or the existing uv branch — only the new
`pdm.lock` branch is inserted, between the uv branch and the `requirements.txt` fallback.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/discover.test.ts`
Expected: PASS (30/30 — 25 existing + 5 new).

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS across all test files (types, discover, lockfiles/poetry, lockfiles/pipenv,
lockfiles/uv, lockfiles/pdm, score, report, index) — zero regressions.

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
git commit -m "feat: detect and parse PDM projects (pyproject.toml + pdm.lock)"
```

---

### Task 3: Bump version, tag, and release

**Files:** none created or modified beyond `package.json`.

**Interfaces:** none — this is a release-process task, not a code task.

**Context for whoever executes this task:** a prior release of this same repo (v1.3.0, uv
support) was merged to `main` but the version-bump/tag/release step was accidentally skipped for
several turns afterward, causing a live end-to-end test against the `@v1` moving tag to fail with
a confusing `ENOENT` (the released bundle simply didn't contain the new feature yet — not a code
bug). Do not repeat that gap: this task exists specifically to make the release step an explicit,
checked-off part of this plan rather than something to remember separately afterward.

The version at plan-writing time is `1.3.0` (confirmed in `package.json`); this task bumps it to
`1.4.0` — a minor bump, since this is a new, backward-compatible feature, matching this repo's
established versioning convention for every prior format addition. If the version has changed
since this plan was written (e.g. another release happened first), read the actual current
`"version"` field in `package.json` and bump the minor component from whatever that is instead.

- [ ] **Step 1: Bump the version in `package.json`**

Change `"version": "1.3.0"` to `"version": "1.4.0"`.

- [ ] **Step 2: Commit and push the version bump**

```bash
git add package.json
git commit -m "chore: bump version to 1.4.0 for PDM lockfile support"
git push origin main
```

- [ ] **Step 3: Tag and push the release tag**

```bash
git tag v1.4.0
git push origin v1.4.0
```

- [ ] **Step 4: Monitor the release workflow**

Run: `gh run list --workflow=release.yml --limit 1 --json databaseId,status,conclusion`

Wait for the run to complete, then confirm success using the `databaseId` printed by the previous
command:

Run: `gh run view <databaseId printed above> --json status,conclusion`
Expected: `"status": "completed"`, `"conclusion": "success"`.

- [ ] **Step 5: Verify the released tag actually contains the PDM feature**

Do not trust the release workflow's success alone — confirm the built bundle genuinely contains
the new code, using a runtime string literal (not a source identifier name, which minification is
free to mangle away):

```bash
git ls-remote --tags origin v1 v1.4.0
```

Expected: both tags point to the same commit SHA — call this `<released-sha>`, the value printed
by the command above (it will differ from any SHA seen earlier in this plan, since the release
workflow creates a new "build dist" commit).

```bash
git fetch origin --tags
git show <released-sha printed above>:dist/index.js | grep -c "pdm.lock"
```

Expected: a non-zero count, confirming the released `dist/index.js` genuinely contains PDM-related
code — this is the check that would have caught the v1.3.0 gap immediately, had it been run at
release time instead of discovered later during live testing.

- [ ] **Step 6: Sync local tags and fast-forward main**

```bash
git tag -f v1.4.0 <released-sha printed above>
git tag -f v1 <released-sha printed above>
git merge --ff-only origin/main
```
