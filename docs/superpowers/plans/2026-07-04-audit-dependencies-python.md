# audit-dependencies-python Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new GitHub Action, `packagerating/audit-dependencies-python`, that parses a Python project's `requirements.txt`, scores each package against packagerating.com (`language=python`), and reports results via PR comment and job summary — mirroring `packagerating/audit-dependencies`'s proven architecture and UX for the npm ecosystem.

**Architecture:** `discover` → `score` → `report`, exactly like `audit-dependencies`. `discover.ts` parses `requirements.txt` (including recursive `-r` includes) into `{name, version}` pairs, where `version` is populated only for an exact `==X.Y.Z` pin — everything else (ranges, bare names, VCS/URL requirements) falls back to unversioned scoring. `score.ts` and `report.ts` are close adaptations of `audit-dependencies`'s modules, with the only functional difference being `language=python` threaded into every API call.

**Tech Stack:** TypeScript, Node 20, `@actions/core`, `@actions/github`, `@vercel/ncc` (bundling), `vitest` (testing) — identical stack to `audit-dependencies`, since a GitHub Action runs on Node regardless of which ecosystem it audits.

## Global Constraints

- Repo: `packagerating/audit-dependencies-python` (already created, cloned locally at `/Users/marcelo/dev/packagerating/audit-dependencies-python`, with one existing commit containing the design spec at `docs/superpowers/specs/2026-07-04-audit-dependencies-python-design.md`).
- Scope: `requirements.txt` only. No `pyproject.toml`, Poetry/PDM/uv lockfiles, or `Pipfile` support in this plan.
- `requirements.txt` parsing rules (from the spec, binding exactly as written):
  1. Trim each line; skip if empty.
  2. Skip if the trimmed line starts with `#` (whole-line comments only; inline comments after a real requirement are NOT specially handled — they become part of the requirement text and will simply fail to match the version-pin pattern, falling back to unversioned).
  3. If the trimmed line starts with `-`: `-r <path>` / `--requirement <path>` / `--requirement=<path>` recursively parses that file (path resolved relative to the *current* file's directory); any other flag (`-e`, `--editable`, `-i`, `--index-url`, `--extra-index-url`, `--find-links`, `--no-index`, `-c`, `--constraint`, etc.) is skipped entirely.
  4. Skip VCS/URL requirements: line contains `://`, or starts with `git+`, `hg+`, `svn+`, `bzr+`, or is a bare local path (starts with `.` or `/`).
  5. Otherwise, parse as a requirement: strip everything from the first `;` onward (environment marker, never evaluated); extract the name (everything before the first `[`, `=`, `>`, `<`, `~`, or `!`); strip an extras bracket (`[...]`) immediately after the name if present; match the remainder against `^==([\w.\-+]+)$` exactly — a lone `==X.Y.Z` constraint yields that version, anything else (range, compatible-release `~=`, bare name, multiple constraints) yields no version (unversioned fallback).
- API contract: `GET https://api.packagerating.com/packages/:name?language=python` (add `&version=X` when a version was resolved) — confirmed against `msoffredi/package-rating`'s `src/api/routes/packages.ts`, which defaults `language` to `'javascript'` when omitted and validates against `SUPPORTED_LANGUAGES` (which includes `python`/`pypi`). No changes needed on the API side.
- The `packages` input (explicit comma-separated override) bypasses `requirements.txt` parsing entirely and scores exactly those names, unversioned — same escape-hatch semantics as `audit-dependencies`.
- `score.ts`/`report.ts`/threshold-gating logic is duplicated from `audit-dependencies`, not extracted into a shared library — matches the org's "one repo per distributable artifact, no monorepo" convention.
- Release workflow includes the tag-then-build-then-move-tag sequencing already fixed in `audit-dependencies` v1.4.1 (see below) — this repo starts correct from day one, no separate fix needed.

---

### Task 1: Repo scaffolding, CI/release workflows, shared types

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `src/types.ts`
- Test: `tests/types.test.ts`

**Interfaces:**
- Produces: `PackageScore` (`{name: string, version: string | null, generalScore: number | null, automationScore: number | null, riskScore: number | null, status: 'scored' | 'unscored' | 'crawl-error'}`), `Thresholds` (`{general: number | null, automation: number | null, risk: number | null}`) — both exported from `src/types.ts`, consumed by every later task.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "audit-dependencies-python",
  "version": "0.1.0",
  "private": true,
  "description": "Score your Python dependencies with packagerating.com",
  "main": "dist/index.js",
  "scripts": {
    "build": "ncc build src/index.ts -o dist",
    "build:minify": "ncc build src/index.ts -o dist --minify",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@actions/core": "^1.10.1",
    "@actions/github": "^6.0.0"
  },
  "devDependencies": {
    "@types/node": "^26.1.0",
    "@vercel/ncc": "^0.38.3",
    "typescript": "^5.4.5",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "lib"
  },
  "include": ["src", "tests", "vitest.config.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 15000,
  },
})
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
lib/

.worktrees/
```

- [ ] **Step 5: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

- [ ] **Step 6: Create `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run build:minify
      - name: Commit dist
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add dist/index.js
          git diff --staged --quiet || git commit -m "chore: build dist for ${{ github.ref_name }}"
          git push origin HEAD:main
      - name: Move version tag to the dist-build commit
        run: |
          git tag -f "${{ github.ref_name }}"
          git push origin "${{ github.ref_name }}" --force
      - name: Create GitHub Release
        run: gh release create "${{ github.ref_name }}" --generate-notes
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - name: Update major version tag
        run: |
          MAJOR=$(echo "${{ github.ref_name }}" | grep -oE '^v[0-9]+')
          git tag -f "$MAJOR"
          git push origin "$MAJOR" --force
```

- [ ] **Step 7: Write the failing test for `src/types.ts`**

```typescript
// tests/types.test.ts
import { describe, it, expect } from 'vitest'
import type { PackageScore, Thresholds } from '../src/types'

describe('types', () => {
  it('PackageScore accepts a fully-populated scored package', () => {
    const score: PackageScore = {
      name: 'requests',
      version: '2.31.0',
      generalScore: 84,
      automationScore: 88,
      riskScore: 12,
      status: 'scored',
    }
    expect(score.name).toBe('requests')
  })

  it('Thresholds accepts all-null (no gating configured)', () => {
    const thresholds: Thresholds = { general: null, automation: null, risk: null }
    expect(thresholds.general).toBeNull()
  })
})
```

- [ ] **Step 8: Run the test to verify it fails (module not found)**

Run: `npx vitest run tests/types.test.ts`
Expected: FAIL — `src/types.ts` does not exist yet.

- [ ] **Step 9: Create `src/types.ts`**

```typescript
export interface PackageScore {
  name: string
  version: string | null
  generalScore: number | null
  automationScore: number | null
  riskScore: number | null
  status: 'scored' | 'unscored' | 'crawl-error'
}

export interface Thresholds {
  general: number | null
  automation: number | null
  risk: number | null
}
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npx vitest run tests/types.test.ts`
Expected: PASS (2/2)

- [ ] **Step 11: Install dependencies, verify project scaffolding is sound**

Run: `npm install`
Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .github/workflows/ci.yml .github/workflows/release.yml src/types.ts tests/types.test.ts
git commit -m "chore: scaffold repo, CI/release workflows, shared types"
```

---

### Task 2: `requirements.txt` discovery

**Files:**
- Create: `src/discover.ts`
- Test: `tests/discover.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (only Node's built-in `fs`/`path`).
- Produces: `DiscoveredPackage` (`{name: string, version: string | null}`), `discoverPackages(requirementsPath: string, explicitPackages: string[]): DiscoveredPackage[]` — consumed by Task 3 (`score.ts`) and Task 5 (`index.ts`).

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/discover.test.ts
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
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/discover.test.ts`
Expected: FAIL — `src/discover.ts` does not exist yet.

- [ ] **Step 3: Implement `src/discover.ts`**

```typescript
import * as fs from 'fs'
import * as path from 'path'

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

export function discoverPackages(requirementsPath: string, explicitPackages: string[]): DiscoveredPackage[] {
  if (explicitPackages.length > 0) {
    return [...new Set(explicitPackages)].map(name => ({ name, version: null }))
  }

  const all = parseFile(requirementsPath, new Set())

  const byName = new Map<string, DiscoveredPackage>()
  for (const pkg of all) byName.set(pkg.name, pkg)
  return [...byName.values()]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/discover.test.ts`
Expected: PASS (13/13)

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/discover.ts tests/discover.test.ts
git commit -m "feat: parse requirements.txt into discovered packages"
```

---

### Task 3: Scoring via packagerating.com (`language=python`)

**Files:**
- Create: `src/score.ts`
- Test: `tests/score.test.ts`

**Interfaces:**
- Consumes: `DiscoveredPackage` from `src/discover.ts` (Task 2); `PackageScore` from `src/types.ts` (Task 1).
- Produces: `scorePackages(packages: DiscoveredPackage[], apiKey: string, crawlTimeoutSeconds: number): Promise<PackageScore[]>` — consumed by Task 5 (`index.ts`).

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/score.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { scorePackages } from '../src/score'
import type { DiscoveredPackage } from '../src/discover'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function ok(body: unknown, status = 200) {
  return Promise.resolve({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) })
}
function notFound() {
  return Promise.resolve({ status: 404, ok: false, json: () => Promise.resolve({ error: 'not found' }) })
}
function serverError() {
  return Promise.resolve({ status: 500, ok: false, json: () => Promise.resolve({}) })
}
function accepted(jobId: string) {
  return Promise.resolve({ status: 202, ok: false, json: () => Promise.resolve({ job_id: jobId }) })
}

function pkg(name: string, version: string | null = null): DiscoveredPackage {
  return { name, version }
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('scorePackages', () => {
  it('returns scored package on a direct 200', async () => {
    mockFetch.mockResolvedValue(ok({ general_score: 84, automation_score: 88, risk_score: 12, version: '2.31.0' }))
    const result = await scorePackages([pkg('requests')], 'key', 10)
    expect(result).toEqual([{
      name: 'requests', version: '2.31.0', generalScore: 84, automationScore: 88, riskScore: 12, status: 'scored',
    }])
  })

  it('always includes language=python in the request URL', async () => {
    mockFetch.mockResolvedValue(ok({ general_score: 84, automation_score: 88, risk_score: 12, version: '2.31.0' }))
    await scorePackages([pkg('requests')], 'key', 10)
    const [url] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.packagerating.com/packages/requests?language=python')
  })

  it('includes both language=python and version when a version is given', async () => {
    mockFetch.mockResolvedValue(ok({ general_score: 84, automation_score: 88, risk_score: 12, version: '2.31.0' }))
    await scorePackages([pkg('requests', '2.31.0')], 'key', 10)
    const [url] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.packagerating.com/packages/requests?language=python&version=2.31.0')
  })

  it('sends the x-api-key header', async () => {
    mockFetch.mockResolvedValue(ok({ general_score: 84, automation_score: 88, risk_score: 12, version: '2.31.0' }))
    await scorePackages([pkg('requests')], 'my-secret-key', 10)
    const [, options] = mockFetch.mock.calls[0]!
    expect((options as { headers: Record<string, string> }).headers['x-api-key']).toBe('my-secret-key')
  })

  it('returns unscored on a direct 404', async () => {
    mockFetch.mockResolvedValue(notFound())
    const result = await scorePackages([pkg('nonexistent-pkg')], 'key', 10)
    expect(result).toEqual([{
      name: 'nonexistent-pkg', version: null, generalScore: null, automationScore: null, riskScore: null, status: 'unscored',
    }])
  })

  it('returns crawl-error on a non-ok, non-404, non-202 response', async () => {
    mockFetch.mockResolvedValue(serverError())
    const result = await scorePackages([pkg('requests')], 'key', 10)
    expect(result[0]!.status).toBe('crawl-error')
  })

  it('returns crawl-error when fetch itself throws', async () => {
    mockFetch.mockRejectedValue(new Error('network down'))
    const result = await scorePackages([pkg('requests')], 'key', 10)
    expect(result[0]!.status).toBe('crawl-error')
  })

  it('polls the job from a 202 response and returns scored once done', async () => {
    vi.useFakeTimers()
    mockFetch
      .mockResolvedValueOnce(accepted('job-1'))
      .mockResolvedValueOnce(ok({ status: 'processing' }))
      .mockResolvedValueOnce(ok({ status: 'done' }))
      .mockResolvedValueOnce(ok({ general_score: 70, automation_score: 60, risk_score: 20, version: '2.31.0' }))

    const promise = scorePackages([pkg('requests')], 'key', 30)
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(5000)
    }
    const result = await promise

    expect(result[0]!.status).toBe('scored')
    expect(result[0]!.generalScore).toBe(70)
    vi.useRealTimers()
  })

  it('returns unscored if the job finishes but the re-fetch is a 404', async () => {
    vi.useFakeTimers()
    mockFetch
      .mockResolvedValueOnce(accepted('job-2'))
      .mockResolvedValueOnce(ok({ status: 'done' }))
      .mockResolvedValueOnce(notFound())

    const promise = scorePackages([pkg('requests')], 'key', 30)
    await vi.advanceTimersByTimeAsync(5000)
    const result = await promise

    expect(result[0]!.status).toBe('unscored')
    vi.useRealTimers()
  })

  it('scores multiple packages independently', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ general_score: 84, automation_score: 88, risk_score: 12, version: '2.31.0' }))
      .mockResolvedValueOnce(notFound())

    const result = await scorePackages([pkg('requests', '2.31.0'), pkg('nonexistent-pkg')], 'key', 10)
    expect(result).toHaveLength(2)
    expect(result.find(r => r.name === 'requests')!.status).toBe('scored')
    expect(result.find(r => r.name === 'nonexistent-pkg')!.status).toBe('unscored')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/score.test.ts`
Expected: FAIL — `src/score.ts` does not exist yet.

- [ ] **Step 3: Implement `src/score.ts`**

```typescript
import type { PackageScore } from './types'
import type { DiscoveredPackage } from './discover'

const API_BASE = 'https://api.packagerating.com'

interface ApiPackageResponse {
  version?: string | null
  general_score?: number | null
  automation_score?: number | null
  risk_score?: number | null
}

interface CrawlTriggerResponse {
  job_id?: string
}

interface CrawlJobResponse {
  status: string
  processed?: number
  total?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function buildUrl(name: string, version: string | null): string {
  const base = `${API_BASE}/packages/${encodeURIComponent(name)}`
  const params = new URLSearchParams({ language: 'python' })
  if (version) params.set('version', version)
  return `${base}?${params.toString()}`
}

function emptyScore(name: string, status: PackageScore['status']): PackageScore {
  return { name, version: null, generalScore: null, automationScore: null, riskScore: null, status }
}

function parseApiResponse(name: string, data: ApiPackageResponse): PackageScore | 'not-found' {
  if (data.general_score == null && data.automation_score == null && data.risk_score == null) {
    return 'not-found'
  }

  return {
    name,
    version: data.version ?? null,
    generalScore: data.general_score ?? null,
    automationScore: data.automation_score ?? null,
    riskScore: data.risk_score ?? null,
    status: 'scored',
  }
}

async function fetchScore(name: string, version: string | null, apiKey: string): Promise<PackageScore | 'not-found'> {
  const res = await fetch(buildUrl(name, version), { headers: { 'x-api-key': apiKey } })
  if (res.status === 404) return 'not-found'
  if (!res.ok) throw new Error(`GET /packages/${name} returned ${res.status}`)

  const data = await res.json() as ApiPackageResponse
  return parseApiResponse(name, data)
}

async function pollJob(
  name: string,
  version: string | null,
  jobId: string,
  apiKey: string,
  deadline: number,
): Promise<PackageScore> {
  while (Date.now() < deadline) {
    await sleep(5000)
    const pollRes = await fetch(`${API_BASE}/packages/crawl/${jobId}`, {
      headers: { 'x-api-key': apiKey },
    })
    if (!pollRes.ok) continue

    let job: CrawlJobResponse
    try {
      job = await pollRes.json() as CrawlJobResponse
    } catch {
      continue
    }

    const done =
      job.status === 'done' ||
      (typeof job.processed === 'number' && typeof job.total === 'number' && job.processed >= job.total)

    if (done) {
      const result = await fetchScore(name, version, apiKey)
      return result === 'not-found' ? emptyScore(name, 'unscored') : result
    }
  }

  return emptyScore(name, 'unscored')
}

async function fetchOrCrawl(
  name: string,
  version: string | null,
  apiKey: string,
  timeoutMs: number,
): Promise<PackageScore> {
  try {
    const res = await fetch(buildUrl(name, version), { headers: { 'x-api-key': apiKey } })

    if (res.status === 404) return emptyScore(name, 'unscored')

    if (res.status === 202) {
      const body = await res.json() as CrawlTriggerResponse
      if (!body.job_id) return emptyScore(name, 'crawl-error')
      return await pollJob(name, version, body.job_id, apiKey, Date.now() + timeoutMs)
    }

    if (!res.ok) return emptyScore(name, 'crawl-error')

    const data = await res.json() as ApiPackageResponse
    const result = parseApiResponse(name, data)
    return result === 'not-found' ? emptyScore(name, 'unscored') : result
  } catch {
    return emptyScore(name, 'crawl-error')
  }
}

export async function scorePackages(
  packages: DiscoveredPackage[],
  apiKey: string,
  crawlTimeoutSeconds: number,
): Promise<PackageScore[]> {
  const timeoutMs = crawlTimeoutSeconds * 1000
  return Promise.all(
    packages.map(({ name, version }) => fetchOrCrawl(name, version, apiKey, timeoutMs)),
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/score.test.ts`
Expected: PASS (10/10)

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/score.ts tests/score.test.ts
git commit -m "feat: score discovered packages against packagerating.com (language=python)"
```

---

### Task 4: Reporting (job summary + PR comment)

**Files:**
- Create: `src/report.ts`
- Test: `tests/report.test.ts`

**Interfaces:**
- Consumes: `PackageScore`, `Thresholds` from `src/types.ts` (Task 1).
- Produces: `buildMarkdownTable(scores: PackageScore[], thresholds: Thresholds): string`, `writeJobSummary(scores: PackageScore[], thresholds: Thresholds): Promise<void>`, `upsertPrComment(scores: PackageScore[], thresholds: Thresholds, token: string): Promise<void>` — consumed by Task 5 (`index.ts`).

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/report.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as core from '@actions/core'
import * as github from '@actions/github'
import { buildMarkdownTable, writeJobSummary, upsertPrComment } from '../src/report'
import type { PackageScore, Thresholds } from '../src/types'

function scored(name: string, generalScore: number, automationScore: number, riskScore: number, version = '1.0.0'): PackageScore {
  return { name, version, generalScore, automationScore, riskScore, status: 'scored' }
}

const noThresholds: Thresholds = { general: null, automation: null, risk: null }

describe('buildMarkdownTable', () => {
  it('sorts ascending by generalScore, unscored packages last', () => {
    const scores: PackageScore[] = [
      scored('high', 90, 90, 5),
      scored('low', 20, 30, 60),
      { name: 'missing', version: null, generalScore: null, automationScore: null, riskScore: null, status: 'unscored' },
    ]
    const table = buildMarkdownTable(scores, noThresholds)
    const lines = table.split('\n').filter(l => l.startsWith('|') && !l.startsWith('|---'))
    const names = lines.slice(1).map(l => l.split('|')[1]!.trim())
    expect(names).toEqual(['low', 'high', 'missing'])
  })

  it('marks a score below the general threshold with a warning', () => {
    const scores = [scored('flask', 40, 90, 5)]
    const table = buildMarkdownTable(scores, { general: 50, automation: null, risk: null })
    expect(table).toContain('40 ⚠️')
  })

  it('marks a score at or above the general threshold with a checkmark', () => {
    const scores = [scored('flask', 60, 90, 5)]
    const table = buildMarkdownTable(scores, { general: 50, automation: null, risk: null })
    expect(table).toContain('60 ✅')
  })

  it('treats risk as lower-is-better: a risk score above threshold warns', () => {
    const scores = [scored('flask', 90, 90, 70)]
    const table = buildMarkdownTable(scores, { general: null, automation: null, risk: 50 })
    expect(table).toContain('70 ⚠️')
  })

  it('shows a note for unscored packages', () => {
    const scores: PackageScore[] = [
      { name: 'missing', version: null, generalScore: null, automationScore: null, riskScore: null, status: 'unscored' },
    ]
    const table = buildMarkdownTable(scores, noThresholds)
    expect(table).toContain('Crawl timed out')
  })

  it('shows a note for crawl-error packages', () => {
    const scores: PackageScore[] = [
      { name: 'broken', version: null, generalScore: null, automationScore: null, riskScore: null, status: 'crawl-error' },
    ]
    const table = buildMarkdownTable(scores, noThresholds)
    expect(table).toContain('Crawl error')
  })
})

describe('writeJobSummary', () => {
  it('writes a heading and the table to the job summary', async () => {
    const addHeading = vi.fn().mockReturnThis()
    const addRaw = vi.fn().mockReturnThis()
    const addEOL = vi.fn().mockReturnThis()
    const write = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(core, 'summary', 'get').mockReturnValue({ addHeading, addRaw, addEOL, write } as unknown as typeof core.summary)

    await writeJobSummary([scored('requests', 84, 88, 12)], noThresholds)

    expect(addHeading).toHaveBeenCalledWith('Package Rating Audit (Python)', 2)
    expect(write).toHaveBeenCalled()
  })
})

describe('upsertPrComment', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('does nothing when not running in a pull_request event', async () => {
    vi.spyOn(github, 'context', 'get').mockReturnValue({ eventName: 'push', payload: {}, repo: { owner: 'o', repo: 'r' } } as unknown as typeof github.context)
    const getOctokitSpy = vi.spyOn(github, 'getOctokit')
    await upsertPrComment([scored('requests', 84, 88, 12)], noThresholds, 'token')
    expect(getOctokitSpy).not.toHaveBeenCalled()
  })

  it('does nothing when no token is provided', async () => {
    vi.spyOn(github, 'context', 'get').mockReturnValue({
      eventName: 'pull_request',
      payload: { pull_request: { number: 1 } },
      repo: { owner: 'o', repo: 'r' },
    } as unknown as typeof github.context)
    const getOctokitSpy = vi.spyOn(github, 'getOctokit')
    await upsertPrComment([scored('requests', 84, 88, 12)], noThresholds, '')
    expect(getOctokitSpy).not.toHaveBeenCalled()
  })

  it('creates a new comment when none exists yet', async () => {
    vi.spyOn(github, 'context', 'get').mockReturnValue({
      eventName: 'pull_request',
      payload: { pull_request: { number: 7 } },
      repo: { owner: 'o', repo: 'r' },
    } as unknown as typeof github.context)

    const createComment = vi.fn().mockResolvedValue(undefined)
    const listComments = vi.fn().mockResolvedValue({ data: [] })
    vi.spyOn(github, 'getOctokit').mockReturnValue({
      rest: { issues: { listComments, createComment, updateComment: vi.fn() } },
    } as unknown as ReturnType<typeof github.getOctokit>)

    await upsertPrComment([scored('requests', 84, 88, 12)], noThresholds, 'token')

    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({ owner: 'o', repo: 'r', issue_number: 7 }))
  })

  it('updates the existing comment when one already exists', async () => {
    vi.spyOn(github, 'context', 'get').mockReturnValue({
      eventName: 'pull_request',
      payload: { pull_request: { number: 7 } },
      repo: { owner: 'o', repo: 'r' },
    } as unknown as typeof github.context)

    const updateComment = vi.fn().mockResolvedValue(undefined)
    const listComments = vi.fn().mockResolvedValue({
      data: [{ id: 42, body: '<!-- packagerating-audit-python -->\nold content' }],
    })
    vi.spyOn(github, 'getOctokit').mockReturnValue({
      rest: { issues: { listComments, createComment: vi.fn(), updateComment } },
    } as unknown as ReturnType<typeof github.getOctokit>)

    await upsertPrComment([scored('requests', 84, 88, 12)], noThresholds, 'token')

    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 42 }))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/report.test.ts`
Expected: FAIL — `src/report.ts` does not exist yet.

- [ ] **Step 3: Implement `src/report.ts`**

```typescript
import * as core from '@actions/core'
import * as github from '@actions/github'
import type { PackageScore, Thresholds } from './types'

const COMMENT_MARKER = '<!-- packagerating-audit-python -->'

function scoreCell(value: number | null, threshold: number | null, direction: 'higher-is-better' | 'lower-is-better' = 'higher-is-better'): string {
  if (value === null) return '—'
  const rounded = Math.round(value)
  if (threshold === null) return String(rounded)
  const passes = direction === 'higher-is-better' ? value >= threshold : value <= threshold
  return passes ? `${rounded} ✅` : `${rounded} ⚠️`
}

function noteCell(pkg: PackageScore): string {
  if (pkg.status === 'unscored') return 'Crawl timed out'
  if (pkg.status === 'crawl-error') return 'Crawl error'
  return ''
}

export function buildMarkdownTable(scores: PackageScore[], thresholds: Thresholds): string {
  const sorted = [...scores].sort((a, b) => {
    if (a.generalScore === null && b.generalScore === null) return 0
    if (a.generalScore === null) return 1
    if (b.generalScore === null) return -1
    return a.generalScore - b.generalScore
  })

  const rows = sorted.map(pkg =>
    `| ${pkg.name} | ${pkg.version ?? '—'} | ${scoreCell(pkg.generalScore, thresholds.general)} | ${scoreCell(pkg.automationScore, thresholds.automation)} | ${scoreCell(pkg.riskScore, thresholds.risk, 'lower-is-better')} | ${noteCell(pkg)} |`,
  )

  return [
    '| Package | Version | General | Automation | Risk | Note |',
    '|---|---|---|---|---|---|',
    ...rows,
  ].join('\n')
}

export async function writeJobSummary(scores: PackageScore[], thresholds: Thresholds): Promise<void> {
  const table = buildMarkdownTable(scores, thresholds)
  await core.summary
    .addHeading('Package Rating Audit (Python)', 2)
    .addRaw(table)
    .addEOL()
    .write()
}

export async function upsertPrComment(scores: PackageScore[], thresholds: Thresholds, token: string): Promise<void> {
  const { eventName, payload } = github.context
  if (eventName !== 'pull_request' || !payload.pull_request) return

  if (!token) return

  try {
    const octokit = github.getOctokit(token)
    const { owner, repo } = github.context.repo
    const prNumber = (payload.pull_request as { number: number }).number

    const table = buildMarkdownTable(scores, thresholds)
    const body = [
      COMMENT_MARKER,
      '## Package Rating Audit (Python)',
      '',
      table,
      '',
      '_Updated by [packagerating/audit-dependencies-python](https://github.com/packagerating/audit-dependencies-python) · [packagerating.com](https://packagerating.com)_',
    ].join('\n')

    const comments = await octokit.rest.issues.listComments({ owner, repo, issue_number: prNumber })
    const existing = comments.data.find(c => c.body?.includes(COMMENT_MARKER))

    if (existing) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body })
    } else {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body })
    }
  } catch (err) {
    core.warning(`Failed to post PR comment: ${err instanceof Error ? err.message : String(err)}`)
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/report.test.ts`
Expected: PASS (11/11)

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/report.ts tests/report.test.ts
git commit -m "feat: report scores via job summary and PR comment"
```

---

### Task 5: Action entry point, metadata, and documentation

**Files:**
- Create: `src/index.ts`
- Create: `action.yml`
- Create: `README.md`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `discoverPackages` from `src/discover.ts` (Task 2); `scorePackages` from `src/score.ts` (Task 3); `writeJobSummary`, `upsertPrComment` from `src/report.ts` (Task 4); `PackageScore`, `Thresholds` from `src/types.ts` (Task 1).
- Produces: `run(): Promise<void>` (the action entry point), `checkThresholds(scores: PackageScore[], thresholds: Thresholds): string[]` (exported for testing) — nothing later depends on these; this is the final wiring task.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/index.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { checkThresholds } from '../src/index'
import type { PackageScore, Thresholds } from '../src/types'

function scored(name: string, generalScore: number, automationScore: number, riskScore: number): PackageScore {
  return { name, version: '1.0.0', generalScore, automationScore, riskScore, status: 'scored' }
}

describe('checkThresholds', () => {
  it('returns no failures when all scores pass', () => {
    const failures = checkThresholds([scored('requests', 80, 80, 10)], { general: 50, automation: 50, risk: 50 })
    expect(failures).toEqual([])
  })

  it('fails when generalScore is below the general threshold', () => {
    const failures = checkThresholds([scored('requests', 30, 80, 10)], { general: 50, automation: null, risk: null })
    expect(failures).toEqual(['requests (general: 30 < 50)'])
  })

  it('fails when riskScore is above the risk threshold', () => {
    const failures = checkThresholds([scored('requests', 80, 80, 70)], { general: null, automation: null, risk: 50 })
    expect(failures).toEqual(['requests (risk: 70 > 50)'])
  })

  it('ignores unscored packages entirely', () => {
    const scores: PackageScore[] = [
      { name: 'missing', version: null, generalScore: null, automationScore: null, riskScore: null, status: 'unscored' },
    ]
    const failures = checkThresholds(scores, { general: 50, automation: 50, risk: 50 })
    expect(failures).toEqual([])
  })

  it('combines multiple threshold failures for the same package', () => {
    const failures = checkThresholds([scored('requests', 30, 20, 70)], { general: 50, automation: 50, risk: 50 })
    expect(failures).toEqual(['requests (general: 30 < 50, automation: 20 < 50, risk: 70 > 50)'])
  })
})

describe('run() integration', () => {
  let getInputMock: ReturnType<typeof vi.fn>
  let setOutputMock: ReturnType<typeof vi.fn>
  let setFailedMock: ReturnType<typeof vi.fn>
  let discoverPackagesMock: ReturnType<typeof vi.fn>
  let scorePackagesMock: ReturnType<typeof vi.fn>
  let writeJobSummaryMock: ReturnType<typeof vi.fn>
  let upsertPrCommentMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()

    getInputMock = vi.fn()
    setOutputMock = vi.fn()
    setFailedMock = vi.fn()
    discoverPackagesMock = vi.fn().mockReturnValue([{ name: 'requests', version: '2.31.0' }])
    scorePackagesMock = vi.fn().mockResolvedValue([scored('requests', 80, 80, 10)])
    writeJobSummaryMock = vi.fn().mockResolvedValue(undefined)
    upsertPrCommentMock = vi.fn().mockResolvedValue(undefined)

    vi.doMock('@actions/core', () => ({
      getInput: (...args: unknown[]) => getInputMock(...args),
      setOutput: (...args: unknown[]) => setOutputMock(...args),
      setFailed: (...args: unknown[]) => setFailedMock(...args),
      info: vi.fn(),
      warning: vi.fn(),
      summary: {
        addHeading: vi.fn().mockReturnThis(),
        addRaw: vi.fn().mockReturnThis(),
        addEOL: vi.fn().mockReturnThis(),
        write: vi.fn().mockResolvedValue(undefined),
      },
    }))
    vi.doMock('../src/discover', () => ({
      discoverPackages: (...args: unknown[]) => discoverPackagesMock(...args),
    }))
    vi.doMock('../src/score', () => ({
      scorePackages: (...args: unknown[]) => scorePackagesMock(...args),
    }))
    vi.doMock('../src/report', () => ({
      writeJobSummary: (...args: unknown[]) => writeJobSummaryMock(...args),
      upsertPrComment: (...args: unknown[]) => upsertPrCommentMock(...args),
    }))
  })

  async function runWithInputs(inputs: Record<string, string>): Promise<void> {
    const defaults: Record<string, string> = {
      'api-key': 'test-key',
      'requirements-path': 'requirements.txt',
      packages: '',
      'fail-on-general': '',
      'fail-on-automation': '',
      'fail-on-risk': '',
      'pr-comment': 'false',
      'github-token': '',
      'crawl-timeout': '10',
    }
    const merged = { ...defaults, ...inputs }
    getInputMock.mockImplementation((name: string) => merged[name] ?? '')

    const { run } = await import('../src/index')
    await run()
  }

  it('scores explicit packages when the packages input is set, bypassing requirements.txt', async () => {
    discoverPackagesMock.mockReturnValue([
      { name: 'flask', version: null },
      { name: 'django', version: null },
    ])
    scorePackagesMock.mockResolvedValue([
      { name: 'flask', version: null, generalScore: 80, automationScore: 80, riskScore: 10, status: 'scored' },
      { name: 'django', version: null, generalScore: 80, automationScore: 80, riskScore: 10, status: 'scored' },
    ])

    await runWithInputs({ packages: 'flask,django' })

    expect(discoverPackagesMock).toHaveBeenCalledWith('requirements.txt', ['flask', 'django'])
    expect(scorePackagesMock).toHaveBeenCalled()
  })

  it('reads the requirements-path input and passes it through to discoverPackages', async () => {
    await runWithInputs({ 'requirements-path': 'reqs/prod.txt' })
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[0]).toBe('reqs/prod.txt')
  })

  it('reads the github-token input and passes it through to upsertPrComment', async () => {
    await runWithInputs({ 'pr-comment': 'true', 'github-token': 'gh-token-123' })
    expect(upsertPrCommentMock).toHaveBeenCalledTimes(1)
    const [, , token] = upsertPrCommentMock.mock.calls[0]!
    expect(token).toBe('gh-token-123')
  })

  it('calls writeJobSummary before gating regardless of outcome', async () => {
    scorePackagesMock.mockResolvedValue([scored('requests', 10, 10, 10)])
    await runWithInputs({ 'fail-on-general': '50' })
    expect(writeJobSummaryMock).toHaveBeenCalledTimes(1)
    expect(setFailedMock).toHaveBeenCalled()
  })

  it('calls core.setFailed when a package fails a threshold', async () => {
    scorePackagesMock.mockResolvedValue([scored('requests', 10, 80, 80)])
    await runWithInputs({ 'fail-on-general': '50' })
    expect(setFailedMock).toHaveBeenCalledWith(expect.stringContaining('requests'))
  })

  it('does not call core.setFailed when no package fails a threshold', async () => {
    scorePackagesMock.mockResolvedValue([scored('requests', 80, 80, 80)])
    await runWithInputs({ 'fail-on-general': '50' })
    expect(writeJobSummaryMock).toHaveBeenCalledTimes(1)
    expect(setFailedMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/index.test.ts`
Expected: FAIL — `src/index.ts` does not exist yet.

- [ ] **Step 3: Implement `src/index.ts`**

```typescript
import * as core from '@actions/core'
import { discoverPackages } from './discover'
import { scorePackages } from './score'
import { writeJobSummary, upsertPrComment } from './report'
import type { PackageScore, Thresholds } from './types'

function parseThreshold(value: string): number | null {
  if (!value.trim()) return null
  const n = parseInt(value, 10)
  if (isNaN(n) || n < 0 || n > 100) throw new Error(`Invalid threshold: "${value}" — must be 0–100`)
  return n
}

export function checkThresholds(scores: PackageScore[], thresholds: Thresholds): string[] {
  const failures: string[] = []
  for (const pkg of scores.filter(s => s.status === 'scored')) {
    const reasons: string[] = []
    if (thresholds.general !== null && pkg.generalScore !== null && pkg.generalScore < thresholds.general) {
      reasons.push(`general: ${pkg.generalScore} < ${thresholds.general}`)
    }
    if (thresholds.automation !== null && pkg.automationScore !== null && pkg.automationScore < thresholds.automation) {
      reasons.push(`automation: ${pkg.automationScore} < ${thresholds.automation}`)
    }
    if (thresholds.risk !== null && pkg.riskScore !== null && pkg.riskScore > thresholds.risk) {
      reasons.push(`risk: ${pkg.riskScore} > ${thresholds.risk}`)
    }
    if (reasons.length > 0) {
      failures.push(`${pkg.name} (${reasons.join(', ')})`)
    }
  }
  return failures
}

export async function run(): Promise<void> {
  const thresholds: Thresholds = {
    general: parseThreshold(core.getInput('fail-on-general')),
    automation: parseThreshold(core.getInput('fail-on-automation')),
    risk: parseThreshold(core.getInput('fail-on-risk')),
  }

  const explicitPackages = core.getInput('packages')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  const packages = discoverPackages(
    core.getInput('requirements-path') || 'requirements.txt',
    explicitPackages,
  )

  core.info(`Scoring ${packages.length} package(s)...`)
  const scores = await scorePackages(
    packages,
    core.getInput('api-key', { required: true }),
    parseInt(core.getInput('crawl-timeout') || '120', 10),
  )

  await writeJobSummary(scores, thresholds)
  if (core.getInput('pr-comment') !== 'false') {
    await upsertPrComment(scores, thresholds, core.getInput('github-token'))
  }

  const scoredCount = scores.filter(s => s.status === 'scored').length
  core.setOutput('packages-scored', String(scoredCount))

  const failures = checkThresholds(scores, thresholds)
  const belowThreshold = failures.map(f => f.split(' ')[0]!)
  core.setOutput('packages-below-threshold', belowThreshold.join(','))

  if (failures.length > 0) {
    core.setFailed(`${failures.length} package(s) below threshold: ${failures.join('; ')}`)
  }
}

if (require.main === module) {
  run().catch(err => core.setFailed(err instanceof Error ? err.message : String(err)))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/index.test.ts`
Expected: PASS (11/11 — 5 `checkThresholds` tests + 6 `run()` integration tests)

- [ ] **Step 5: Create `action.yml`**

```yaml
name: 'Audit Python Dependencies'
description: 'Score your Python dependencies with packagerating.com and report results in pull requests'
author: 'packagerating'

inputs:
  api-key:
    description: 'Your packagerating.com API key'
    required: true
  requirements-path:
    description: 'Path to requirements.txt relative to repo root'
    required: false
    default: 'requirements.txt'
  packages:
    description: 'Explicit comma-separated package list (overrides requirements.txt discovery)'
    required: false
    default: ''
  fail-on-general:
    description: 'Fail if any package general_score is below this threshold (0–100)'
    required: false
    default: ''
  fail-on-automation:
    description: 'Fail if any package automation_score is below this threshold (0–100)'
    required: false
    default: ''
  fail-on-risk:
    description: 'Fail if any package risk_score is above this threshold (0–100) — higher risk_score means riskier'
    required: false
    default: ''
  pr-comment:
    description: 'Post results as a PR comment (requires pull-requests: write permission)'
    required: false
    default: 'true'
  github-token:
    description: 'Token used to post/update the PR comment'
    required: false
    default: '${{ github.token }}'
  crawl-timeout:
    description: 'Seconds to wait for on-demand crawl of unscored packages'
    required: false
    default: '120'

outputs:
  packages-scored:
    description: 'Number of packages successfully scored'
  packages-below-threshold:
    description: 'Comma-separated list of packages that failed at least one threshold'

runs:
  using: 'node20'
  main: 'dist/index.js'

branding:
  icon: 'shield'
  color: 'blue'
```

- [ ] **Step 6: Create `README.md`**

```markdown
# audit-dependencies-python

Score your Python dependencies with [packagerating.com](https://packagerating.com) in your GitHub
Actions workflow. Resolves each package's exact pinned version from `requirements.txt` (when
pinned with `==`) and scores it — not "latest" — so results reflect what your project actually
installs.

## Usage

```yaml
name: Audit Dependencies

on:
  pull_request:
    branches: [main]

permissions:
  pull-requests: write

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: packagerating/audit-dependencies-python@v1
        with:
          api-key: ${{ secrets.PACKAGERATING_API_KEY }}
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `api-key` | *(required)* | Your packagerating.com API key |
| `requirements-path` | `requirements.txt` | Path to `requirements.txt` relative to repo root |
| `packages` | *(none)* | Explicit comma-separated package list — overrides `requirements.txt` discovery entirely |
| `fail-on-general` | *(none)* | Fail the run if any package's general score is below this (0–100) |
| `fail-on-automation` | *(none)* | Fail the run if any package's automation score is below this (0–100) |
| `fail-on-risk` | *(none)* | Fail the run if any package's risk score is above this (0–100) — higher means riskier |
| `pr-comment` | `true` | Post/update a PR comment with results |
| `github-token` | `${{ github.token }}` | Token used to post the PR comment |
| `crawl-timeout` | `120` | Seconds to wait for an on-demand crawl of an unscored package |

## Outputs

| Output | Description |
|---|---|
| `packages-scored` | Number of packages successfully scored |
| `packages-below-threshold` | Comma-separated list of packages that failed at least one threshold |

## Version resolution

Only an exact `==X.Y.Z` pin in `requirements.txt` yields a resolved version — a package pinned
this way is scored at that exact version. A range (`>=1.0,<2.0`), a compatible-release pin
(`~=1.4`), or a bare name with no constraint has no way to determine which version is actually
installed from `requirements.txt` alone, so it's scored unversioned (the package's latest release).

`-r other-requirements.txt` / `--requirement other-requirements.txt` includes are followed
recursively, so a project split across `requirements/base.txt` + `requirements/dev.txt` (where
`dev.txt` starts with `-r base.txt`) is fully discovered from a single `requirements-path`.

## Out of scope

This action currently supports `requirements.txt` only — `pyproject.toml`-based tooling (Poetry,
PDM, uv) and `Pipfile`/`Pipfile.lock` are not yet supported.
```

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — all tests across all 5 test files (types, discover, score, report, index).

- [ ] **Step 8: Run typecheck**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 9: Commit**

```bash
git add src/index.ts action.yml README.md tests/index.test.ts
git commit -m "feat: wire discover/score/report into the action entry point, add metadata and docs"
```

---

### Task 6: Full verification

**Files:** none created or modified — this task only runs verification commands.

**Interfaces:** none — this is the final check before handoff to `finishing-a-development-branch`.

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: all test files pass, zero failures.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Run the production build**

Run: `npm run build`
Expected: succeeds, produces `dist/index.js`.

- [ ] **Step 4: Revert the verification build artifact**

`dist/index.js` is committed only by the release workflow (Task 1's `release.yml`), not by hand
during development — revert this local build so `git status` stays clean:

```bash
git checkout -- dist/index.js 2>/dev/null || rm -rf dist
git status --short
```

Expected: no unexpected modifications remain (only untracked scratch directories like
`.superpowers/`, if present, are acceptable).

- [ ] **Step 5: Confirm no stray files**

```bash
git status --short
```

Expected: clean, or only known-safe untracked scratch directories.
