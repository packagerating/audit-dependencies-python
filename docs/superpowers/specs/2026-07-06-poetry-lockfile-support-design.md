# Poetry Lockfile Support

## Problem

`audit-dependencies-python` v1.0.0 only reads `requirements.txt`. Poetry is one of the most
widely used Python dependency managers, declaring dependencies in `pyproject.toml` and resolving
them to exact versions in `poetry.lock` — a project using Poetry either has no `requirements.txt`
at all, or exports a stale, manually-regenerated one that can drift from what's actually locked.
Poetry projects have no accurate way to be audited by this action today.

## Design

### Detection (`src/discover.ts`, extended)

Detection is automatic, keyed off `poetry.lock`'s presence — no new required input. In the same
directory `requirements-path` resolves to (default: repo root), check for `poetry.lock`:

- **If found:** ignore `requirements.txt` entirely. Read `pyproject.toml` (same directory) for
  dependency *names*, and `poetry.lock` for resolved *versions*.
- **If not found:** fall back to today's `requirements.txt` parsing, completely unchanged.

This mirrors the sibling `audit-dependencies` (npm) action's own auto-detection pattern — pnpm's
`pnpm-workspace.yaml` takes priority over `package.json`'s `workspaces` field, checked
unconditionally before falling back. Poetry projects just work without any new configuration.

The explicit `packages` input (comma-separated override) continues to bypass both `requirements.txt`
and Poetry parsing entirely, exactly as it does today — an unconditional escape hatch, not a
per-format concern.

### Reading `pyproject.toml`

Parsed as TOML. Dependency *names* (not versions — those come from the lockfile) are collected
from three places, all included unconditionally (no separate "include dev" flag/input, matching
this feature's explicit scope choice):

1. **`[tool.poetry.dependencies]`** — the main/production dependency table. The `python` key
   (Python's own version constraint, e.g. `python = "^3.10"`) is always present here and is NOT a
   package — it must be explicitly skipped.
2. **Every `[tool.poetry.group.<name>.dependencies]` table**, for any group name (`dev`, `test`,
   `docs`, or any custom group a project defines) — Poetry 1.2+'s modern dependency-group syntax.
3. **`[tool.poetry.dev-dependencies]`** — Poetry's legacy (pre-1.2) dev-dependency table, if
   present, for backward compatibility with older `pyproject.toml` files.

A dependency's TOML value can be either a plain string (`requests = "^2.31.0"`) or a table
(`flask = {version = "^3.0.0", optional = true}`, or with `extras = [...]`, or a git/path source).
Only the *key* (the package name) is used here in every case — the value (range, `optional` flag,
extras, source) is never inspected, since the actual installed version is resolved from
`poetry.lock`, not from this declared range. Collected names are deduplicated across all three
sources (a name appearing in both the main table and a group table counts once).

### Reading `poetry.lock`

Parsed as TOML. Build a name→version map from every `[[package]]` array entry's `name` and
`version` fields. This is a **flat list covering every group together** — Poetry's lockfile format
does not partition locked packages by which group requested them, so no group-filtering happens at
this stage; filtering already happened when collecting names from `pyproject.toml` in the previous
step.

Package names are matched **case-insensitively, with `-`, `_`, and `.` treated as equivalent**
(PEP 503 normalization: lowercase, and any of the three separator characters normalize to a single
`-`). Poetry itself normalizes names this way internally, so a naive exact-string comparison would
silently fail to match a real dependency whenever its `pyproject.toml` spelling differs from its
`poetry.lock` spelling in case or separator style (e.g. `PyYAML` vs `pyyaml`, or `some_pkg` vs
`some-pkg`).

### New dependency

`smol-toml` — a modern, TypeScript-native, actively-maintained, full TOML 1.0.0-spec-compliant
parser. Chosen over the older `@iarna/toml`/`toml` alternatives for being lighter and more actively
maintained.

## Out of Scope

- **PDM (`pdm.lock`) and uv (`uv.lock`).** Both also key off `pyproject.toml` but have their own
  distinct lockfile formats — deliberately deferred to a future version of this repo, not part of
  this spec.
- **`Pipfile`/`Pipfile.lock`** (Pipenv) — a different manifest format entirely, also deferred.
- **Poetry's `optional`/extras-conditional inclusion.** An `optional = true` dependency (only
  installed when a specific extra is requested) is still audited unconditionally, matching this
  action's existing environment-marker philosophy (a marker is stripped, not evaluated — see the
  original spec's Out of Scope section) — there's no reliable way for this action to know which
  extras, if any, a consuming project actually installs.

## Testing

- Detection: `poetry.lock` present → Poetry mode used, `requirements.txt` ignored even if it also
  exists; `poetry.lock` absent → `requirements.txt` mode, completely unchanged from v1.0.0
  behavior; explicit `packages` input bypasses both regardless of which lockfile is present.
- `pyproject.toml` name collection: main `[tool.poetry.dependencies]` table (`python` key
  correctly skipped); a `[tool.poetry.group.dev.dependencies]` table; a custom-named group table
  (e.g. `[tool.poetry.group.test.dependencies]`); legacy `[tool.poetry.dev-dependencies]`; a
  dependency declared as a table value (`{version = "...", optional = true}`) — only its name is
  collected; a name appearing in two different groups is only counted once in the final result.
- `poetry.lock` version resolution: exact name match resolves to the locked version; a name
  differing only in case (`PyYAML` vs `pyyaml`) or separator style (`some_pkg` vs `some-pkg`)
  still resolves correctly via PEP 503 normalization.
- Regression: all v1.0.0 `requirements.txt` behavior (13+ existing test cases) continues to pass
  unmodified when no `poetry.lock` is present.

## Files (additions to the existing repo layout)

| File | Purpose |
|---|---|
| `src/discover.ts` | Modified — adds Poetry detection branch alongside existing `requirements.txt` parsing |
| `package.json` | Modified — adds `smol-toml` dependency |
