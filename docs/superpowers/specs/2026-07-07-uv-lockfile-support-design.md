# uv Lockfile Support

## Problem

`audit-dependencies-python` supports `requirements.txt` (v1.0.0), Poetry (v1.1.0), and Pipenv
(v1.2.0). uv (by Astral, makers of Ruff) is the fastest-growing Python dependency manager,
declaring dependencies in `pyproject.toml` (standard PEP 621/508 format) and resolving them to
exact versions in `uv.lock`. uv projects have no accurate way to be audited by this action today.

## Design

### Detection (`src/discover.ts`, extended)

The existing dispatch order gains a new tier, inserted after the existing `Pipfile.lock` check and
before the `requirements.txt` fallback:

- **If `poetry.lock` exists:** Poetry mode (existing, unchanged, still checked first).
- **Else if `Pipfile.lock` exists:** Pipenv mode (existing, unchanged).
- **Else if `uv.lock` exists:** uv mode (this spec).
- **Else:** `requirements.txt` mode (existing, unchanged, still the final fallback).

All checks look in the same directory `requirements-path` resolves to. This preserves every
existing precedence relationship exactly as-is — a Poetry or Pipenv project is never affected by
this change, even if a `uv.lock` also happens to be present (an unlikely but possible scenario).
The explicit `packages` input continues to bypass all four modes, checked first, before any
file-system detection.

Like Poetry (and unlike Pipenv, whose `Pipfile.lock` is self-sufficient), uv needs both files:
`uv.lock`'s flat package list isn't filtered to just what the project actually declares as a
dependency, so `pyproject.toml` is still required to know which names are actually in scope.

### Reading `pyproject.toml` (new `src/lockfiles/uv.ts`)

Unlike Poetry's table-based `[tool.poetry.dependencies]` (`name = "range"` key-value pairs), uv
follows the standard PEP 621/508 format: dependencies are declared as an **array of requirement
strings**, e.g. `dependencies = ["requests>=2.31.0", "flask[async]>=3.0.0"]`. Names are collected,
unconditionally and deduplicated, from three sources — matching the precedent set by Poetry:

1. **`[project.dependencies]`** — the main/production dependency array.
2. **Every group in `[dependency-groups]`**, for any group name (`dev`, `test`, or any custom
   group) — the modern PEP 735 standard for dependency groups.
3. **`[tool.uv.dev-dependencies]`** — uv's legacy dev-dependency array, predating PEP 735
   adoption, for backward compatibility with older `pyproject.toml` files.

Each entry is a PEP 508 requirement string (e.g. `"flask[async]>=3.0.0; python_version >= '3.8'"`)
— only the package *name* is extracted (strip everything from the first `;` onward as an
environment marker, then take everything before the first `[`, `=`, `>`, `<`, `~`, or `!`,
trimmed). This mirrors the exact name-extraction logic already used for `requirements.txt`
parsing, reimplemented fresh in this new file rather than shared — matching how `poetry.ts` and
`pipenv.ts` don't share helpers between lockfile modules today.

### Reading `uv.lock`

Parsed as TOML — a flat `[[package]]` array, structurally identical to `poetry.lock`'s. Build a
name→version map from every entry's `name`/`version` fields. Package names are matched using the
same PEP 503 normalization already implemented for Poetry (case-insensitive, with `-`, `_`, `.`
treated as equivalent) — necessary since `pyproject.toml`'s declared spelling can differ from
`uv.lock`'s normalized entry (e.g. `PyYAML` vs `pyyaml`). No new dependency is needed — `smol-toml`
(already added for Poetry) parses `uv.lock` too.

## Out of Scope

- **PDM (`pdm.lock`)** — remains deferred, not part of this spec.
- **uv workspaces** (multiple `pyproject.toml` files sharing one root `uv.lock`) — only the root
  project's own dependency declarations (at the same directory as `requirements-path`) are read;
  member-project-specific dependencies in a workspace are not discovered.

## Testing

- Detection: `uv.lock` present (with `poetry.lock` and `Pipfile.lock` both absent) → uv mode used,
  `requirements.txt` ignored; `poetry.lock` present → Poetry mode wins even if `uv.lock` also
  exists; `Pipfile.lock` present (no `poetry.lock`) → Pipenv mode wins even if `uv.lock` also
  exists; none present → `requirements.txt` mode, completely unchanged; explicit `packages` input
  bypasses all four regardless of which lockfiles are present.
- `pyproject.toml` name collection: `[project.dependencies]` array; a `[dependency-groups.dev]`
  array; a custom-named group; legacy `[tool.uv.dev-dependencies]`; a PEP 508 string with extras
  (`flask[async]>=3.0.0`) yields just `flask`; a PEP 508 string with an environment marker yields
  the name with the marker stripped; a name appearing in two different sources is deduplicated to
  one entry.
- `uv.lock` version resolution: exact name match resolves to the locked version; a name differing
  only in case or separator style still resolves correctly via PEP 503 normalization.
- Regression: all existing `requirements.txt`, Poetry, and Pipenv test cases continue to pass
  unmodified when no `uv.lock` is present, or when a higher-precedence lockfile wins.

## Files (additions to the existing repo layout)

| File | Purpose |
|---|---|
| `src/discover.ts` | Modified — adds `uv.lock` detection tier between the existing `Pipfile.lock` check and the `requirements.txt` fallback |
| `src/lockfiles/uv.ts` | New — parses `pyproject.toml`'s PEP 508 dependency arrays and `uv.lock`'s flat package list into `DiscoveredPackage[]` |
