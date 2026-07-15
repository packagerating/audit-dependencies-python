# Independent Subproject Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the action discover and score independent Python projects living in subdirectories
of the same repo — each with its own `requirements.txt`, `pyproject.toml`, or `Pipfile`, and its
own lockfile — not just the single configured `requirements-path` root.

**Architecture:** A new `src/subprojects.ts` module glob-scans the repo for directories containing
any of `requirements.txt`, `pyproject.toml`, or `Pipfile`, bounded by a configurable max depth and
a hardcoded + user-extendable exclude list. `discover.ts`'s existing per-directory format-dispatch
logic (poetry.lock → Pipfile.lock → uv.lock → pdm.lock → plain requirements.txt fallback) is
extracted into a shared helper, called once for the configured root and once per discovered
subproject; results are combined and deduplicated by package name exactly as the existing
requirements.txt-multi-include-path dedup already works. Three new action inputs
(`audit-subprojects`, `subproject-max-depth`, `subproject-exclude`) control it.

**Tech Stack:** TypeScript, Vitest, `fast-glob` (new dependency, already proven in the sibling
`packagerating/audit-dependencies` action), `@actions/core`, `smol-toml`.

## Global Constraints

- `discoverSubprojects(rootDir, maxDepth, extraExcludeGlobs)` returns deduplicated, relative
  (POSIX-style) directory paths from `rootDir` — no `alreadyDiscovered` parameter (this repo has
  no formal-workspace concept to avoid double-counting against).
- A directory is a subproject root if it contains any of `requirements.txt`, `pyproject.toml`, or
  `Pipfile` — a directory with more than one of these is only returned once.
- Fixed, non-overridable default excludes, always applied regardless of `extraExcludeGlobs`:
  `node_modules`, `.git`, `dist`, `build`, `coverage`, `vendor`, `venv`, `.venv`, `__pycache__`,
  `.tox`, `*.egg-info`, `site-packages`, `examples`, `fixtures`, `test`, `tests`, `__tests__`,
  `e2e`.
- The configured root's own directory (depth 0) is never included in `discoverSubprojects`'s
  result.
- `discoverPackages`'s new positional parameters, in order, appended after the existing 2:
  `auditSubprojects: boolean`, `subprojectMaxDepth: number`, `subprojectExcludeGlobs: string[]`.
- New action inputs and exact defaults: `audit-subprojects` (default `'true'`),
  `subproject-max-depth` (default `'3'`), `subproject-exclude` (default `''`).
- Every existing test in `tests/discover.test.ts` and `tests/index.test.ts` must continue passing
  with no behavior change — achieved by passing `auditSubprojects: false` (a no-op) from every
  call site that doesn't specifically test subproject behavior.
- Subprojects never trigger when `explicitPackages.length > 0`, mirroring the existing rule that
  explicit packages bypass all discovery entirely.
- Each discovered subproject's `requirements.txt` (when that's the format in play) is assumed to
  be literally named `requirements.txt` inside its directory — there is no per-subproject
  `requirements-path` override; only the configured root has a customizable filename.

---

### Task 1: `discoverSubprojects` in `src/subprojects.ts`

**Files:**
- Modify: `package.json` (add `fast-glob` dependency)
- Create: `src/subprojects.ts`
- Test: `tests/subprojects.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export function discoverSubprojects(
    rootDir: string,
    maxDepth: number,
    extraExcludeGlobs: string[],
  ): string[]
  ```
  Returns relative (POSIX-style, `/`-separated) directory paths from `rootDir`, one per discovered
  independent subproject root, excluding the root's own directory.

- [ ] **Step 1: Add `fast-glob` as a dependency**

In `package.json`, add to `"dependencies"` (matching the version already proven in the sibling
`packagerating/audit-dependencies` action):

```json
  "dependencies": {
    "@actions/core": "^1.10.1",
    "@actions/github": "^6.0.0",
    "fast-glob": "^3.3.3",
    "smol-toml": "^1.7.0"
  },
```

Run: `npm install`
Expected: `package-lock.json` updates to include `fast-glob` and its transitive dependencies.

- [ ] **Step 2: Write the failing tests**

Create `tests/subprojects.test.ts`, following this repo's existing real-temp-directory test
pattern (see `tests/discover.test.ts`'s `write()` helper — this test file uses the same approach,
not a mocked `fs`):

```typescript
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- tests/subprojects.test.ts`
Expected: FAIL — `Cannot find module '../src/subprojects'` (module does not exist yet).

- [ ] **Step 4: Write the implementation**

Create `src/subprojects.ts`:

```typescript
import * as path from 'path'
import fg from 'fast-glob'

const MANDATORY_EXCLUDE_GLOBS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/vendor/**',
  '**/venv/**',
  '**/.venv/**',
  '**/__pycache__/**',
  '**/.tox/**',
  '**/*.egg-info/**',
  '**/site-packages/**',
  '**/examples/**',
  '**/fixtures/**',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/e2e/**',
]

export function discoverSubprojects(
  rootDir: string,
  maxDepth: number,
  extraExcludeGlobs: string[],
): string[] {
  const matches = fg.sync('**/{requirements.txt,pyproject.toml,Pipfile}', {
    cwd: rootDir,
    ignore: [...MANDATORY_EXCLUDE_GLOBS, ...extraExcludeGlobs],
    dot: false,
  })

  const result = new Set<string>()

  for (const match of matches) {
    const dir = path.posix.dirname(match)
    if (dir === '.') continue // the configured root's own directory
    const depth = dir.split('/').length
    if (depth > maxDepth) continue
    result.add(dir)
  }

  return [...result]
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/subprojects.test.ts`
Expected: PASS (13 tests, 0 failures).

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/subprojects.ts tests/subprojects.test.ts
git commit -m "feat: add discoverSubprojects for independent Python monorepo project discovery"
```

---

### Task 2: Extract shared resolution logic and wire subprojects into `discover.ts`

**Files:**
- Modify: `src/discover.ts`
- Test: `tests/discover.test.ts` (all 30 existing calls updated; new tests added)

**Interfaces:**
- Consumes: `discoverSubprojects(rootDir, maxDepth, extraExcludeGlobs): string[]` from Task 1
  (`src/subprojects.ts`).
- Produces:
  ```typescript
  export function discoverPackages(
    requirementsPath: string,
    explicitPackages: string[],
    auditSubprojects: boolean,
    subprojectMaxDepth: number,
    subprojectExcludeGlobs: string[],
  ): DiscoveredPackage[]
  ```
  Same behavior as today for every existing caller when `auditSubprojects` is `false`.

- [ ] **Step 1: Update `src/discover.ts`**

Replace the full file content:

```typescript
import * as fs from 'fs'
import * as path from 'path'
import { collectPoetryDependencyNames, resolvePoetryVersions } from './lockfiles/poetry'
import { parsePipfileLock } from './lockfiles/pipenv'
import { collectUvDependencyNames, resolveUvVersions } from './lockfiles/uv'
import { collectPdmDependencyNames, resolvePdmVersions } from './lockfiles/pdm'
import { discoverSubprojects } from './subprojects'

export interface DiscoveredPackage {
  name: string
  version: string | null
}

function isRequirementInclude(trimmed: string): string | null {
  const match = trimmed.match(/^(?:-r|--requirement)(?:\s+|=)(.+)$/)
  return match ? match[1]!.trim() : null
}

function isVcsOrUrl(trimmed: string): boolean {
  if (trimmed.includes('://')) return true
  if (/^(git|hg|svn|bzr)\+/.test(trimmed)) return true
  if (trimmed.startsWith('.') || trimmed.startsWith('/')) return true
  return false
}

function parseRequirementLine(trimmed: string): DiscoveredPackage | null {
  const withoutMarker = trimmed.split(';')[0]!.trim()
  if (!withoutMarker) return null

  const nameMatch = withoutMarker.match(/^([^[=><~!]+)/)
  if (!nameMatch) return null
  const name = nameMatch[1]!.trim()
  if (!name) return null

  let rest = withoutMarker.slice(nameMatch[0].length).trim()

  if (rest.startsWith('[')) {
    const closeIdx = rest.indexOf(']')
    if (closeIdx === -1) return { name, version: null }
    rest = rest.slice(closeIdx + 1).trim()
  }

  const versionMatch = rest.match(/^==([\w.\-+]+)$/)
  return { name, version: versionMatch ? versionMatch[1]! : null }
}

function parseFile(filePath: string, seen: Set<string>): DiscoveredPackage[] {
  const resolvedPath = path.resolve(filePath)
  if (seen.has(resolvedPath)) return []
  seen.add(resolvedPath)

  const content = fs.readFileSync(resolvedPath, 'utf8')
  const results: DiscoveredPackage[] = []

  for (const rawLine of content.split('\n')) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const includePath = isRequirementInclude(trimmed)
    if (includePath) {
      const includeFullPath = path.resolve(path.dirname(resolvedPath), includePath)
      results.push(...parseFile(includeFullPath, seen))
      continue
    }

    if (trimmed.startsWith('-')) continue
    if (isVcsOrUrl(trimmed)) continue

    const pkg = parseRequirementLine(trimmed)
    if (pkg) results.push(pkg)
  }

  return results
}

function resolveDirectory(dir: string, requirementsFileName: string): DiscoveredPackage[] {
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

  return parseFile(path.join(dir, requirementsFileName), new Set())
}

export function discoverPackages(
  requirementsPath: string,
  explicitPackages: string[],
  auditSubprojects: boolean,
  subprojectMaxDepth: number,
  subprojectExcludeGlobs: string[],
): DiscoveredPackage[] {
  if (explicitPackages.length > 0) {
    return [...new Set(explicitPackages)].map(name => ({ name, version: null }))
  }

  const resolvedRequirementsPath = path.resolve(requirementsPath)
  const rootDir = path.dirname(resolvedRequirementsPath)
  const rootRequirementsFileName = path.basename(resolvedRequirementsPath)

  const all: DiscoveredPackage[] = [...resolveDirectory(rootDir, rootRequirementsFileName)]

  if (auditSubprojects) {
    for (const subprojectDir of discoverSubprojects(rootDir, subprojectMaxDepth, subprojectExcludeGlobs)) {
      all.push(...resolveDirectory(path.join(rootDir, subprojectDir), 'requirements.txt'))
    }
  }

  const byName = new Map<string, DiscoveredPackage>()
  for (const pkg of all) byName.set(pkg.name, pkg)
  return [...byName.values()]
}
```

This is a behavior-preserving refactor for every existing (non-subproject) code path: the same
five branches run in the same order against the same `rootDir`, just now inside `resolveDirectory`
instead of inline. The `byName` final dedup now runs unconditionally (previously only the
`parseFile` fallback branch went through it) — for the four lockfile-backed branches, `names.map`
already guarantees name-uniqueness within their own return array, so wrapping them in the same
final dedup is a no-op for every pre-existing single-root call. It only starts doing new work once
subprojects are combined into `all` alongside the root's entries.

- [ ] **Step 2: Update every existing call site in `tests/discover.test.ts`**

Every existing `discoverPackages(path, [...])`-shaped call in the file gains three trailing
arguments: `false, 3, []` — disabling subproject discovery, a no-op, so every existing test's
behavior is unchanged. Every call in the file has one of these shapes; replace every occurrence of
each (there are 30 calls total):

```
discoverPackages(path.join(rootDir, 'requirements.txt'), [])
  → discoverPackages(path.join(rootDir, 'requirements.txt'), [], false, 3, [])
```
(appears 24 times as a bare call across the file — 23 as `const result = discoverPackages(...)`
plus 1 inside `expect(() => discoverPackages(path.join(rootDir, 'requirements.txt'), [])).toThrow()`,
which becomes `expect(() => discoverPackages(path.join(rootDir, 'requirements.txt'), [], false, 3, [])).toThrow()`
— only the inner call gains the arguments, `.toThrow()` itself is unchanged)

```
discoverPackages(path.join(rootDir, 'requirements.txt'), ['flask', 'django'])
  → discoverPackages(path.join(rootDir, 'requirements.txt'), ['flask', 'django'], false, 3, [])

discoverPackages(path.join(rootDir, 'requirements.txt'), ['flask'])
  → discoverPackages(path.join(rootDir, 'requirements.txt'), ['flask'], false, 3, [])

discoverPackages(path.join(rootDir, 'requirements.txt'), ['django'])
  → discoverPackages(path.join(rootDir, 'requirements.txt'), ['django'], false, 3, [])
```
(each appears once or more — `['flask', 'django']` once, `['flask']` once, `['django']` 3 times
across the explicit-packages-bypass tests; replace every occurrence)

After this step, run a verification grep to confirm no old-shape call remains:

```bash
grep -n "discoverPackages(path.join(rootDir, 'requirements.txt')" tests/discover.test.ts | grep -v ", false, 3, \[\])"
```
Expected: no output (every call now ends in the 3-element subproject-args tail).

- [ ] **Step 3: Add new subproject-specific tests to `tests/discover.test.ts`**

Append these `it` blocks inside the existing `describe('discoverPackages', ...)` block, before its
closing `})`:

```typescript
  it('resolves an independent subproject\'s dependencies from its own directory, alongside the root\'s', () => {
    write('requirements.txt', 'requests==2.31.0\n')
    write('service-a/requirements.txt', 'flask==3.0.0\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [], true, 3, [])
    expect(result.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'flask', version: '3.0.0' },
      { name: 'requests', version: '2.31.0' },
    ])
  })

  it('resolves a subproject using Poetry while the root uses plain requirements.txt', () => {
    write('requirements.txt', 'requests==2.31.0\n')
    write(
      'service-a/pyproject.toml',
      `
[tool.poetry.dependencies]
python = "^3.10"
flask = "^3.0.0"
`,
    )
    write(
      'service-a/poetry.lock',
      `
[[package]]
name = "flask"
version = "3.0.0"
`,
    )
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [], true, 3, [])
    expect(result.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'flask', version: '3.0.0' },
      { name: 'requests', version: '2.31.0' },
    ])
  })

  it('does not discover subprojects when auditSubprojects is false, even if independent subprojects exist', () => {
    write('requirements.txt', 'requests==2.31.0\n')
    write('service-a/requirements.txt', 'flask==3.0.0\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [], false, 3, [])
    expect(result).toEqual([{ name: 'requests', version: '2.31.0' }])
  })

  it('falls back to unversioned for a subproject with no lockfile present, matching root no-lockfile behavior', () => {
    write('requirements.txt', 'requests==2.31.0\n')
    write('service-a/requirements.txt', 'flask\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [], true, 3, [])
    expect(result.find(p => p.name === 'flask')).toEqual({ name: 'flask', version: null })
  })

  it('never triggers subproject discovery when explicitPackages is non-empty', () => {
    write('service-a/requirements.txt', 'flask==3.0.0\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), ['django'], true, 3, [])
    expect(result).toEqual([{ name: 'django', version: null }])
  })

  it('excludes a subproject beyond subprojectMaxDepth', () => {
    write('requirements.txt', 'requests==2.31.0\n')
    write('a/b/c/requirements.txt', 'flask==3.0.0\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [], true, 2, [])
    expect(result).toEqual([{ name: 'requests', version: '2.31.0' }])
  })

  it('suppresses a subproject via subprojectExcludeGlobs', () => {
    write('requirements.txt', 'requests==2.31.0\n')
    write('scratch/requirements.txt', 'flask==3.0.0\n')
    const result = discoverPackages(path.join(rootDir, 'requirements.txt'), [], true, 3, ['scratch/**'])
    expect(result).toEqual([{ name: 'requests', version: '2.31.0' }])
  })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/discover.test.ts`
Expected: PASS — 37 tests, 0 failures (30 pre-existing + 7 new).

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/discover.ts tests/discover.test.ts
git commit -m "feat: resolve independent subprojects alongside the root in discoverPackages"
```

---

### Task 3: Action inputs and `index.ts` wiring

**Files:**
- Modify: `action.yml`
- Modify: `src/index.ts`
- Modify: `tests/index.test.ts`

**Interfaces:**
- Consumes: `discoverPackages(...)` from Task 2, now requiring 3 additional trailing arguments.

- [ ] **Step 1: Add the three new inputs to `action.yml`**

In `action.yml`, insert immediately after the existing `packages` input block (after its
`default: ''` line, before `fail-on-general:`):

```yaml
  audit-subprojects:
    description: 'Discover and score independent Python projects in subdirectories (each with their own requirements.txt, pyproject.toml, or Pipfile, and their own lockfile). Set to false to disable.'
    required: false
    default: 'true'
  subproject-max-depth:
    description: 'Maximum directory depth (below repo root) to scan for independent Python project roots'
    required: false
    default: '3'
  subproject-exclude:
    description: 'Comma-separated additional glob patterns to exclude from subproject discovery (node_modules, .git, dist, build, coverage, vendor, venv, .venv, __pycache__, .tox, *.egg-info, site-packages, examples, fixtures, test, tests, __tests__, and e2e are always excluded regardless of this input)'
    required: false
    default: ''
```

- [ ] **Step 2: Read the new inputs in `src/index.ts` and pass them to `discoverPackages`**

In `src/index.ts`, replace:

```typescript
  const packages = discoverPackages(
    core.getInput('requirements-path') || 'requirements.txt',
    explicitPackages,
  )
```

with:

```typescript
  const subprojectExcludeGlobs = core.getInput('subproject-exclude')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  const packages = discoverPackages(
    core.getInput('requirements-path') || 'requirements.txt',
    explicitPackages,
    core.getInput('audit-subprojects') !== 'false',
    parseInt(core.getInput('subproject-max-depth') || '3', 10),
    subprojectExcludeGlobs,
  )
```

Place the `subprojectExcludeGlobs` block directly above the `const packages = discoverPackages(`
line, mirroring the existing `explicitPackages` block's placement and style just above it.

- [ ] **Step 3: Update `tests/index.test.ts`**

Add `'audit-subprojects': 'true'`, `'subproject-max-depth': '3'`, and `'subproject-exclude': ''` to
the `defaults` object inside `runWithInputs`:

```typescript
    const defaults: Record<string, string> = {
      'api-key': 'test-key',
      'requirements-path': 'requirements.txt',
      packages: '',
      'audit-subprojects': 'true',
      'subproject-max-depth': '3',
      'subproject-exclude': '',
      'fail-on-general': '',
      'fail-on-automation': '',
      'fail-on-risk': '',
      'pr-comment': 'false',
      'github-token': '',
      'crawl-timeout': '10',
    }
```

Update the existing test that asserts the exact `discoverPackages` call arguments — replace:

```typescript
    expect(discoverPackagesMock).toHaveBeenCalledWith('requirements.txt', ['flask', 'django'])
```

with:

```typescript
    expect(discoverPackagesMock).toHaveBeenCalledWith('requirements.txt', ['flask', 'django'], true, 3, [])
```

Add these `it` blocks after the existing `'reads the requirements-path input...'` test (after its
closing `})`, before the `'reads the github-token input...'` test):

```typescript
  it('passes auditSubprojects=true to discoverPackages by default', async () => {
    await runWithInputs({})
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[2]).toBe(true)
  })

  it('passes auditSubprojects=false to discoverPackages when audit-subprojects input is "false"', async () => {
    await runWithInputs({ 'audit-subprojects': 'false' })
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[2]).toBe(false)
  })

  it('passes subprojectMaxDepth=3 to discoverPackages by default', async () => {
    await runWithInputs({})
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[3]).toBe(3)
  })

  it('passes a custom subprojectMaxDepth to discoverPackages when subproject-max-depth is set', async () => {
    await runWithInputs({ 'subproject-max-depth': '5' })
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[3]).toBe(5)
  })

  it('passes an empty subprojectExcludeGlobs array to discoverPackages by default', async () => {
    await runWithInputs({})
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[4]).toEqual([])
  })

  it('parses subproject-exclude into a trimmed array of globs', async () => {
    await runWithInputs({ 'subproject-exclude': 'scratch/**, tmp/** ' })
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[4]).toEqual(['scratch/**', 'tmp/**'])
  })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/index.test.ts`
Expected: PASS — 17 tests, 0 failures (11 pre-existing + 6 new).

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add action.yml src/index.ts tests/index.test.ts
git commit -m "feat: add audit-subprojects, subproject-max-depth, subproject-exclude action inputs"
```

---

### Task 4: README documentation

**Files:**
- Modify: `README.md`

**Interfaces:**
- None (documentation only).

- [ ] **Step 1: Add the three new inputs to the Inputs table**

In `README.md`, in the `## Inputs` table, insert these three rows immediately after the `packages`
row:

```markdown
| `audit-subprojects` | `true` | Discover and score independent Python projects in subdirectories (each with their own manifest and lockfile) |
| `subproject-max-depth` | `3` | Maximum directory depth below repo root to scan for independent Python project roots |
| `subproject-exclude` | — | Comma-separated additional glob patterns to exclude from subproject discovery |
```

- [ ] **Step 2: Add a new documentation section**

Insert a new section immediately after the existing `## Version resolution` section (after its
final paragraph, which ends "...is fully discovered from a single `requirements-path`.", and
before `## Out of scope`):

```markdown
## Independent subprojects

Python has no single dominant workspace convention the way npm/yarn/pnpm do, so Python monorepos
are usually several independently-managed projects living in one git repo, each with its own
manifest (`requirements.txt`, `pyproject.toml`, or `Pipfile`) and its own lockfile, with nothing
formally linking them.

By default, this action also discovers these independent subprojects and scores each one's
dependencies resolved the same way the configured root is resolved — Poetry, Pipenv, uv, or PDM
lockfile if present, plain `requirements.txt` parsing otherwise.

Scanning excludes `node_modules`, `.git`, `dist`, `build`, `coverage`, `vendor`, `venv`, `.venv`,
`__pycache__`, `.tox`, `*.egg-info`, `site-packages`, `examples`, `fixtures`, `test`, `tests`,
`__tests__`, and `e2e` always, regardless of `subproject-exclude` — these are not configurable off.
Use `subproject-exclude` to add further comma-separated glob patterns on top, and
`subproject-max-depth` to control how many directory levels below the repo root are scanned
(default `3`).

Set `audit-subprojects: false` to disable this discovery entirely and only audit the configured
`requirements-path` root.
```

- [ ] **Step 3: Update the stale `## Out of scope` section**

The current `## Out of scope` section reads:

```markdown
## Out of scope

This action currently supports `requirements.txt` only — `pyproject.toml`-based tooling (Poetry,
PDM, uv) and `Pipfile`/`Pipfile.lock` are not yet supported.
```

This is inaccurate as of the existing (pre-this-feature) code — `src/discover.ts` already
dispatches to Poetry, Pipenv, uv, and PDM lockfile resolution before falling back to plain
`requirements.txt` parsing, and this feature's new "Independent subprojects" section (Step 2,
directly above this one) explicitly describes all four formats being supported for subprojects
too. Leaving this section as-is would directly contradict the section just added. Replace it with:

```markdown
## Out of scope

- **Per-subproject attribution in the report** — the report doesn't indicate which subproject (or
  the root) a given package came from, just the deduplicated, combined list.
- **Nested subprojects** — a discovered subproject that itself contains further nested manifests
  within `subproject-max-depth` is treated as its own independent leaf, with no special handling
  for a subproject-within-a-subproject.
- **uv's formal `[tool.uv.workspace]` declaration** — uv's own workspace protocol is a distinct
  mechanism from the independent-subproject discovery this action performs; a `[tool.uv.workspace]`
  declaration is not specially detected or honored.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document independent subproject discovery"
```

---

## Self-Review Notes

- **Spec coverage:** `discoverSubprojects` (Task 1), the `resolveDirectory` extraction + wiring
  into `discoverPackages` (Task 2), three new action inputs + `index.ts` wiring (Task 3), README
  (Task 4) — all six "Files Touched" rows from the spec are covered (`package.json` in Task 1,
  the rest as listed). The spec's Testing section items (max-depth boundary, marker-file
  variations, dedup of a directory with multiple markers, fixed-exclude-list coverage including
  Python-specific and fixture directories, `extraExcludeGlobs`, `audit-subprojects: false` no-op,
  no-lockfile fallback, `explicitPackages` bypass, cross-format subproject resolution, regression
  on existing tests) each map to a specific test in Task 1 or Task 2.
- **Placeholder scan:** every step shows complete code — no TBDs. Task 2's call-site update step
  gives the exact two call shapes and their replacements for all 30 existing sites, plus a
  verification grep, rather than a vague "update the calls" instruction, since the transformation
  is fully mechanical and deterministic.
- **Type consistency:** `discoverSubprojects`'s signature in Task 1 matches its only call site in
  Task 2's `discover.ts` exactly (`rootDir, maxDepth, extraExcludeGlobs`, no `alreadyDiscovered` —
  correctly omitted per the spec, since this repo has no formal-workspace concept). `resolveDirectory`
  is defined once in Task 2 and called from two places within the same file (root + each
  subproject) with consistent parameter types. `discoverPackages`'s 5-parameter signature is
  consistent between Task 2 (definition) and Task 3 (call site in `index.ts`).
- **Dedup semantics, called out explicitly:** the shared final `byName` dedup in `discoverPackages`
  is name-only, last-write-wins (root resolved first, then subprojects in discovery order) —
  matching this repo's pre-existing convention for combining multiple `-r`-included files within
  one requirements tree. This is a deliberate simplification, not an oversight: unlike the sibling
  TypeScript action (which dedups by `name@version`, preserving both entries when a root and a
  workspace member resolve genuinely different versions of the same package), this repo had no
  such richer dedup before this feature, and introducing one is out of scope here. If a root and a
  subproject depend on genuinely different versions of the same package, only the last-resolved
  one survives in the final result — documented behavior, not a bug, and consistent with what this
  codebase already does for multiple `-r` includes.
- **README fix bundled into Task 4:** the existing `## Out of scope` section is stale relative to
  the code (claims only `requirements.txt` is supported, when Poetry/Pipenv/uv/PDM already are) —
  fixing it is included in Task 4 because leaving it would directly contradict the new
  "Independent subprojects" section added in the same task, not as unrelated cleanup.
- **No changes needed to `src/score.ts` or `src/report.ts`** — both operate on the flat,
  deduplicated `DiscoveredPackage[]`/`PackageScore[]` with no subproject attribution, so this
  feature requires no changes there. Not listed as a task.
- **Build step:** not included as a plan task, matching the sibling TypeScript action's precedent —
  `npm run build`/`build:minify` (regenerating `dist/`) and the version bump happen once, after all
  four tasks are merged, via this repo's `release.yml` tag-triggered workflow.
