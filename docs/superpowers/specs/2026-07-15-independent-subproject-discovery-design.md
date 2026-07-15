# Independent Subproject Discovery

## Problem

`discoverPackages()` (`src/discover.ts`) only ever looks at one configured root — the directory
containing `requirements-path` (default `requirements.txt`). If that directory doesn't have a
Poetry/Pipenv/uv/PDM lockfile, it falls back to parsing `requirements.txt` directly (following
`-r`/`--requirement` includes within that one file tree). There is no concept of a second,
independent Python project living elsewhere in the same repo.

Unlike JavaScript's npm/yarn/pnpm ecosystem, Python has no dominant, near-universal workspace
protocol (uv has workspaces, but Poetry, Pipenv, and plain pip do not) — so Python monorepos
overwhelmingly use the informal pattern: several independently-managed Python projects living in
one git repo, each with its own manifest (`requirements.txt`, `pyproject.toml`, or `Pipfile`) and
its own lockfile, with nothing linking them. Running this action against such a repo today scores
only whichever one project happens to sit at the configured root; every other project's
dependencies are invisible to the audit, silently.

This mirrors the gap just closed in the sibling TypeScript action
(`packagerating/audit-dependencies`, shipped as `audit-subprojects` in v1.6.0 — see
`packagerating/audit-dependencies/docs/superpowers/specs/2026-07-14-independent-subproject-discovery-design.md`),
adapted here for the fact that this repo has no formal-workspace layer to build on top of — this
feature *is* the whole monorepo story for this action, not an addition to an existing one.

## Design

### Root marker: any of `requirements.txt`, `pyproject.toml`, or `Pipfile`

A directory is a discoverable subproject root if it contains any of the three files already
recognized by this action's existing per-directory format dispatch: `requirements.txt` (plain
pip), `pyproject.toml` (Poetry, uv, or PDM — disambiguated by which lockfile sits alongside it),
or `Pipfile` (Pipenv). This matches all four formats `discoverPackages` already resolves — a
directory with any one of these is treated as its own subproject root and resolved exactly the
way the configured root is resolved today.

### Subproject detection (`src/subprojects.ts`, new)

```typescript
export function discoverSubprojects(
  rootDir: string,
  maxDepth: number,
  extraExcludeGlobs: string[],
): string[]
```

Glob-scans `rootDir` (via `fast-glob`, a new dependency — already used and proven in the sibling
TypeScript action) for `**/{requirements.txt,pyproject.toml,Pipfile}`, bounded by `maxDepth`,
returning relative paths (from `rootDir`) to each containing directory, deduplicated (a directory
with both `pyproject.toml` and `requirements.txt` counts once) — **excluding**:

- The configured root itself (depth 0 — handled separately, exactly as today).
- A fixed, non-overridable default list, applied regardless of `extraExcludeGlobs`:
  - Parity with the TypeScript action's list: `node_modules`, `.git`, `dist`, `build`,
    `coverage`, `vendor`.
  - Python-specific noise: `venv`, `.venv`, `__pycache__`, `.tox`, `*.egg-info`,
    `site-packages`.
  - Common test-fixture directories (added from the start here, learning from the TypeScript
    action's post-ship fix rather than waiting for the same bug report twice):
    `examples`, `fixtures`, `test`, `tests`, `__tests__`, `e2e`.
- Any path matching `extraExcludeGlobs` (user-supplied, additive on top of the fixed list above).

There is no `alreadyDiscovered` parameter (unlike the TypeScript action's version) — that
parameter exists there to avoid double-counting formal workspace members, and this action has no
formal-workspace concept to double-count against.

### Threading subprojects into `discoverPackages`

`discoverPackages` grows from:

```typescript
export function discoverPackages(requirementsPath: string, explicitPackages: string[]): DiscoveredPackage[]
```

to:

```typescript
export function discoverPackages(
  requirementsPath: string,
  explicitPackages: string[],
  auditSubprojects: boolean,
  subprojectMaxDepth: number,
  subprojectExcludeGlobs: string[],
): DiscoveredPackage[]
```

When `explicitPackages` is empty and `auditSubprojects` is true, `discoverSubprojects` runs against
the configured root's directory, and each discovered subproject directory is resolved via the
**exact same per-directory format-dispatch block already in `discoverPackages`** (poetry.lock →
Pipfile.lock → uv.lock → pdm.lock → plain-requirements-parsing fallback) — refactored into a
shared helper called once for the configured root and once per discovered subproject, rather than
duplicated. Each call's results feed into the same final by-name dedup this function already does
— no change needed there. `explicitPackages` non-empty continues to bypass all discovery entirely,
exactly as today.

### New action inputs

Named to match the sibling TypeScript action, for consistency across both actions you maintain:

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

## Out of Scope

- **Per-subproject attribution in the report** — same reasoning as the TypeScript action's
  identical deferral: the report already doesn't attribute packages to their source directory, so
  this isn't a new gap, just an existing one that now also applies to subprojects.
- **Nested subprojects** — each depth-bounded match is treated as its own independent leaf; no
  special handling for a subproject-within-a-subproject.
- **Auto-detecting `subproject-max-depth`** — a fixed, user-configurable default is sufficient.
- **uv workspaces** (uv's own formal `[tool.uv.workspace]` declaration) — out of scope for this
  feature. A future enhancement could detect and honor it the way the TypeScript action detects
  npm/yarn/pnpm workspaces, but this feature only adds the independent-subproject half; uv's
  formal workspace protocol is a different, separate mechanism this spec doesn't address.

## Testing

- `src/subprojects.ts`: `discoverSubprojects` finds an independent subproject root at various
  depths up to `maxDepth` and correctly stops beyond it; matches on any of the three marker files;
  a directory with more than one marker file is only returned once; the fixed exclude list
  (including the Python-specific and fixture-directory additions) is always applied regardless of
  `extraExcludeGlobs`; `extraExcludeGlobs` suppresses an otherwise-matching directory; the
  configured root's own directory is never included in the result.
- `discover.ts`: a repo with one independent subproject (own `pyproject.toml` + own `poetry.lock`,
  distinct dependencies from the root) resolves that subproject's dependencies from its own
  lockfile; a repo with subprojects using different formats (one Poetry, one Pipenv) resolves each
  correctly; `audit-subprojects: false` disables subproject discovery even when independent
  subprojects exist, behaving exactly as before this feature; a subproject with only a
  `requirements.txt` (no lockfile) falls back to parsing it directly, matching the configured
  root's existing no-lockfile behavior; `explicitPackages` non-empty never triggers subproject
  discovery.
- Regression: every existing test in the current `tests/discover.test.ts` continues to pass
  unmodified — achieved via `auditSubprojects: false` as a no-op default on every pre-existing call
  site.

## Files Touched

| File | Change |
|---|---|
| `src/subprojects.ts` | New — `discoverSubprojects` |
| `src/discover.ts` | `discoverPackages` gains 3 parameters; per-directory resolution logic extracted into a shared helper called once per discovered root (configured root + each subproject) |
| `src/index.ts` | Reads new `audit-subprojects`, `subproject-max-depth`, `subproject-exclude` inputs |
| `action.yml` | Documents the three new inputs |
| `README.md` | Documents independent-subproject discovery |
| `package.json` | Adds `fast-glob` as a new dependency |
