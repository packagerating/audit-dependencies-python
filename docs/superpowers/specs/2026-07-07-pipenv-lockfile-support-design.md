# Pipenv (Pipfile/Pipfile.lock) Support

## Problem

`audit-dependencies-python` supports `requirements.txt` (v1.0.0) and Poetry's `pyproject.toml` +
`poetry.lock` (v1.1.0). Pipenv is another widely used Python dependency manager, declaring
dependencies in `Pipfile` and resolving them to exact versions in `Pipfile.lock`. Pipenv projects
have no accurate way to be audited by this action today.

## Design

### Detection (`src/discover.ts`, extended)

The existing dispatch order gains a new middle tier. Today: check `poetry.lock` first, else fall
back to `requirements.txt`. Extended: check `poetry.lock` first (unchanged), then check
`Pipfile.lock`, else fall back to `requirements.txt` (unchanged). Both checks look in the same
directory `requirements-path` resolves to.

- **If `poetry.lock` exists:** Poetry mode (existing behavior, unchanged).
- **Else if `Pipfile.lock` exists:** Pipenv mode (this spec).
- **Else:** `requirements.txt` mode (existing behavior, unchanged).

This preserves `poetry.lock`'s existing precedence exactly as-is and adds `Pipfile.lock` as a new
check before the final fallback — a project with `poetry.lock` present is never affected by this
change. The explicit `packages` input continues to bypass all three modes, checked first, before
any file-system detection.

### Reading `Pipfile.lock` (new `src/lockfiles/pipenv.ts`)

Unlike Poetry — where names come from `pyproject.toml` and versions from a separate `poetry.lock`
— Pipenv's `Pipfile.lock` is self-sufficient: a single JSON file (parsed with the built-in
`JSON.parse`, no new dependency required) that already contains fully-resolved names *and*
versions together. `Pipfile` itself is never read.

`Pipfile.lock`'s top-level `default` (production) and `develop` (dev) sections are both read
unconditionally — no separate include-dev flag, matching the precedent set by Poetry's
unconditional group inclusion. Each section is an object keyed by package name; each package's
value is an object whose `version` field is a string prefixed with `==` (e.g. `"==2.31.0"`) — this
prefix must be stripped to get the bare version (`2.31.0`). A package entry may have no `version`
field at all (an editable/VCS/local-path dependency, e.g. `{"editable": true, "path": "."}` or
`{"git": "...", "ref": "..."}`) — such an entry is skipped entirely, since it isn't a real
registry package with a determinable version, consistent with `requirements.txt` mode's existing
VCS/URL-skip behavior.

A package name appearing in both `default` and `develop` is deduplicated to a single entry — the
`default` section's version wins if the two ever disagree (an edge case that shouldn't occur in a
correctly generated lockfile, but a deterministic tie-break is defined here so behavior is never
ambiguous).

## Out of Scope

- **Custom Pipenv dependency categories** (`[<category>-packages]` in `Pipfile`, corresponding to
  a same-named top-level section in `Pipfile.lock` beyond `default`/`develop`) — a less common
  Pipenv feature, not part of this spec. Only `default` and `develop` are read.
- **`Pipfile` itself.** Never read — `Pipfile.lock` alone is sufficient for both names and
  versions.
- **PDM (`pdm.lock`) and uv (`uv.lock`)** — remain deferred from the Poetry spec, not part of this
  spec either.

## Testing

- Detection: `Pipfile.lock` present (and `poetry.lock` absent) → Pipenv mode used,
  `requirements.txt` ignored even if it also exists; `poetry.lock` present → Poetry mode wins even
  if `Pipfile.lock` also exists (precedence order); neither present → `requirements.txt` mode,
  completely unchanged; explicit `packages` input bypasses all three regardless of which lockfiles
  are present.
- `Pipfile.lock` parsing: a `default`-only package resolves correctly with the `==` prefix
  stripped; a `develop`-only package is included; a package in both sections is deduplicated to
  one entry; a package with no `version` field (editable/VCS/local) is skipped entirely, not
  included with a null version.
- Regression: all existing `requirements.txt` and Poetry test cases continue to pass unmodified
  when no `Pipfile.lock` is present, or when `poetry.lock` takes precedence over it.

## Files (additions to the existing repo layout)

| File | Purpose |
|---|---|
| `src/discover.ts` | Modified — adds `Pipfile.lock` detection tier between the existing `poetry.lock` check and the `requirements.txt` fallback |
| `src/lockfiles/pipenv.ts` | New — parses `Pipfile.lock`'s `default`/`develop` sections into `DiscoveredPackage[]` |
