# PDM Lockfile Support

## Problem

`audit-dependencies-python` supports `requirements.txt` (v1.0.0), Poetry (v1.1.0), Pipenv (v1.2.0),
and uv (v1.3.0). PDM is another established Python dependency manager, also PEP 621-compliant,
declaring dependencies in `pyproject.toml` and resolving them to exact versions in `pdm.lock`. PDM
projects have no accurate way to be audited by this action today. This is the last planned Python
format — completing Python dependency-manager coverage for this action.

## Design

### Detection (`src/discover.ts`, extended)

The existing dispatch order gains a new tier, inserted after the existing `uv.lock` check and
before the `requirements.txt` fallback:

- **If `poetry.lock` exists:** Poetry mode (existing, unchanged, still checked first).
- **Else if `Pipfile.lock` exists:** Pipenv mode (existing, unchanged).
- **Else if `uv.lock` exists:** uv mode (existing, unchanged).
- **Else if `pdm.lock` exists:** PDM mode (this spec).
- **Else:** `requirements.txt` mode (existing, unchanged, still the final fallback).

All checks look in the same directory `requirements-path` resolves to. This preserves every
existing precedence relationship exactly as-is. The explicit `packages` input continues to bypass
all five modes, checked first, before any file-system detection.

Like Poetry and uv (and unlike Pipenv, whose `Pipfile.lock` is self-sufficient), PDM needs both
files: `pdm.lock`'s package list isn't filtered to just what the project actually declares, so
`pyproject.toml` is still required to know which names are in scope.

### Reading `pyproject.toml` (new `src/lockfiles/pdm.ts`)

Structurally near-identical to `src/lockfiles/uv.ts`: PDM follows the same PEP 621/508 standard
for its main dependencies (`[project.dependencies]`, an array of requirement strings), since both
tools are PEP 621-compliant. Names are collected, unconditionally and deduplicated, from three
sources:

1. **`[project.dependencies]`** — the main/production dependency array (same format as uv's).
2. **Every group in `[dependency-groups]`**, for any group name — the shared PEP 735 standard,
   which modern PDM (2.10+) also supports, same as uv.
3. **`[tool.pdm.dev-dependencies]`** — PDM's own legacy dev-dependency table (predating its PEP
   735 adoption), mapping any group name to an array of requirement strings, e.g.
   `test = ["pytest>=8.0.0"]`.

Each entry in all three sources is a PEP 508 requirement string — only the package *name* is
extracted (strip everything from the first `;` onward as an environment marker, then take
everything before the first `[`, `=`, `>`, `<`, `~`, or `!`, trimmed) — reusing the exact
name-extraction approach already implemented in `src/lockfiles/uv.ts`.

### Reading `pdm.lock`

Parsed as TOML — a flat `[[package]]` array, structurally the same shape as `poetry.lock`/
`uv.lock`'s (each entry also carries extra fields like `groups`, `requires_python`, `summary`,
`files` — none of which are needed here, only `name`/`version`). Build a name→version map from
every entry. Package names are matched using the same PEP 503 normalization already implemented
for Poetry and uv (case-insensitive, with `-`, `_`, `.` treated as equivalent). No new dependency
needed — `smol-toml` (already installed) parses `pdm.lock` too.

## Out of Scope

- This completes Python dependency-manager coverage for this action — no further Python lockfile
  formats are planned after this.
- **PDM/uv workspaces** (multiple `pyproject.toml` files sharing one root lockfile) — only the
  root project's own dependency declarations (at the same directory as `requirements-path`) are
  read; this limitation already applies to uv and is inherited here.

## Testing

- Detection: `pdm.lock` present (with `poetry.lock`, `Pipfile.lock`, `uv.lock` all absent) → PDM
  mode used, `requirements.txt` ignored; each higher-precedence lockfile (`poetry.lock`,
  `Pipfile.lock`, `uv.lock`) still wins over `pdm.lock` when both are present; none present →
  `requirements.txt` mode, completely unchanged; explicit `packages` input bypasses all five modes
  regardless of which lockfiles are present.
- `pyproject.toml` name collection: `[project.dependencies]` array; a `[dependency-groups.<name>]`
  array (any group name); `[tool.pdm.dev-dependencies].<name>` array (any group name); a PEP 508
  string with extras yields just the base name; a PEP 508 string with an environment marker yields
  the name with the marker stripped; a name appearing in two different sources is deduplicated to
  one entry.
- `pdm.lock` version resolution: exact name match resolves to the locked version; a name differing
  only in case or separator style still resolves correctly via PEP 503 normalization.
- Regression: all existing `requirements.txt`, Poetry, Pipenv, and uv test cases continue to pass
  unmodified when no `pdm.lock` is present, or when a higher-precedence lockfile wins.

## Files (additions to the existing repo layout)

| File | Purpose |
|---|---|
| `src/discover.ts` | Modified — adds `pdm.lock` detection tier between the existing `uv.lock` check and the `requirements.txt` fallback |
| `src/lockfiles/pdm.ts` | New — parses `pyproject.toml`'s PEP 508 dependency arrays (main + both group syntaxes) and `pdm.lock`'s flat package list into `DiscoveredPackage[]` |
