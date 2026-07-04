# audit-dependencies-python

## Problem

`packagerating/audit-dependencies` scores npm/Yarn/pnpm dependencies against packagerating.com,
resolving exact installed versions from the project's lockfile. packagerating.com's API already
scores Python packages too (`language=python`, registry `pypi`) — but no GitHub Action exists to
audit a Python project's dependencies the same way. Python projects have no equivalent today.

## Design

### New repo: `packagerating/audit-dependencies-python`

A public GitHub Action, TypeScript/Node (matching `audit-dependencies` — a GitHub Action runs on
Node regardless of which ecosystem it audits, and parsing a `requirements.txt` is plain text
processing with no need for a Python runtime in CI). Mirrors `audit-dependencies`' architecture
closely: `discover` → `score` → `report`, with `score.ts`/`report.ts`/threshold-gating logic
duplicated into this repo rather than extracted into a shared library — matches the org's
established "one repo per distributable artifact, no monorepo" convention; there's no shared
library precedent to build on yet, and the alternative (publishing and depending on a shared
internal package) adds real maintenance overhead for two logic blocks that are each under 150
lines.

### Scope: `requirements.txt` only

Python's dependency-manifest ecosystem is fragmented (`requirements.txt`, `pyproject.toml` +
Poetry/PDM/uv lockfiles, `Pipfile` + `Pipfile.lock`). This first version targets `requirements.txt`
only — the oldest and still most widely used format, mirroring how `audit-dependencies` itself
started with npm's `package-lock.json` before Yarn and pnpm were added incrementally later.
`pyproject.toml`-based tooling is an explicit backlog item (see Out of Scope), not part of this
spec.

Unlike npm's manifest+lockfile split (where `package.json` gives only a *range* and a separate
lockfile resolves the *exact* version), a `requirements.txt` pinned with `==` gives an exact
version directly — there is no separate lockfile-resolution step. A `requirements.txt` produced by
`pip freeze` (or hand-pinned with `==` throughout) already *is* the resolved version list.

### Parsing `requirements.txt`

Input: `requirements-path` (default `requirements.txt`, relative to the repo root). Read and
parsed line-by-line, in this exact order per line:

1. **Trim.** Skip if empty.
2. **Comment lines.** Skip if the trimmed line starts with `#`. (Inline comments after a real
   requirement — `requests==2.31.0  # pinned for CVE reasons` — are out of scope; the whole line
   is treated as the requirement including the trailing comment text, which will simply fail to
   match the version-pin pattern in step 5 and fall back to unversioned. This is an acceptable,
   documented limitation, not a crash.)
3. **Pip option flags.** If the trimmed line starts with `-`:
   - `-r <path>` or `--requirement <path>` (also the `--requirement=<path>` form): recursively
     parse the file at `<path>`, resolved relative to the *current* file's directory (supports the
     common `requirements/base.txt` + `requirements/dev.txt` pattern, where `dev.txt` starts with
     `-r base.txt`). Skipping this would silently miss most of a real project's dependencies, so
     it must be followed, not skipped.
   - Any other flag (`-e`, `--editable`, `-i`, `--index-url`, `--extra-index-url`, `--find-links`,
     `--no-index`, `--constraint`, etc.): skip the line entirely — not a package requirement.
4. **VCS/URL requirements.** If the line contains `://`, or starts with `git+`, `hg+`, `svn+`,
   `bzr+`, or is a bare local path (starts with `.` or `/`): skip. These aren't registry packages
   with a version this action can determine.
5. **Package requirement.** Otherwise, parse as a (simplified) PEP 508 requirement:
   - Strip everything from the first `;` onward (an environment marker, e.g.
     `; python_version >= "3.8"`) — marker conditions are never evaluated; a marked package is
     still audited unconditionally (see Out of Scope).
   - Extract the name: everything before the first occurrence of `[` (extras marker), `=`, `>`,
     `<`, `~`, or `!`, trimmed.
   - If an extras marker (`[...]`) is present immediately after the name, remove it — e.g. for
     `requests[security]==2.31.0`, the name is `requests` and the bracketed `[security]` is
     discarded entirely (not treated as part of the name or the version constraint).
   - Extract the version: take whatever remains of the line after removing the name and, if
     present, its extras bracket — e.g. for `requests[security]==2.31.0` that remainder is
     `==2.31.0`; for `requests==2.31.0` (no extras) it's also `==2.31.0`. Match that remainder
     against `^==([\w.\-+]+)$` exactly. A lone `==X.Y.Z` constraint (no other comma-separated
     constraints on the same line) yields that exact version. Anything else — a range
     (`>=1.0,<2.0`), a compatible-release pin (`~=1.4`), no constraint at all (bare `requests`), or
     multiple constraints combined with `==` — yields no version; the package is scored unversioned
     (latest), the same "never throws, always falls back" philosophy as `audit-dependencies`.

### Scoring and reporting

Identical architecture to `audit-dependencies`: `GET /packages/:name?version=X&language=python`
(version omitted when unresolved, matching the existing API contract — no changes needed on the
packagerating.com side, which already supports `language=python`), PR comment / job summary via
the same table format, `fail-on-general`/`fail-on-automation`/`fail-on-risk` threshold gating.

## Out of Scope

- **`pyproject.toml` + Poetry/PDM/uv lockfiles, and `Pipfile`/`Pipfile.lock`.** Real, common Python
  dependency-management tools, deliberately deferred to a future version of this same repo — not
  part of this spec.
- **Environment marker evaluation.** A marker (`; sys_platform == "win32"`) is stripped and
  ignored, not evaluated — a package gated to a platform this workflow doesn't run on is still
  audited unconditionally. Evaluating markers correctly would require knowing the runtime's own
  Python version/platform/implementation, which this action has no reliable way to determine
  in general (the workflow running this action isn't necessarily even a Python environment).
- **Inline comments** after a real requirement line (see parsing step 2) — documented limitation,
  not a crash; degrades to unversioned for that one line.
- **Workspace/multi-project support** (a monorepo with several `requirements.txt` files scattered
  across subdirectories, unrelated by `-r` includes). Only the one file at `requirements-path`
  (plus whatever it recursively `-r`-includes) is audited.

## Testing

- Parsing: exact `==` pin resolves; range/compatible-release/bare-name constraints all fall back
  to unversioned; extras are stripped from the name but don't affect version resolution; comment
  and blank lines are skipped; `-r`/`--requirement` includes are followed recursively (including a
  two-level chain, e.g. `dev.txt` includes `base.txt`); other pip option flags are skipped; VCS/URL
  requirements are skipped; environment markers are stripped without affecting whether the package
  is included.
- Scoring/reporting: same test shape as `audit-dependencies` — `language=python` threaded into the
  API call, threshold gating, PR comment upsert.
- Regression: none yet, this is a new repo.

## Files (new repo layout)

| File | Purpose |
|---|---|
| `src/discover.ts` | Parses `requirements.txt` (and recursive `-r` includes) into package name + optional exact version pairs |
| `src/score.ts` | Calls packagerating.com with `language=python`, same crawl-trigger/poll logic as `audit-dependencies` |
| `src/report.ts` | Job summary / PR comment rendering, same format as `audit-dependencies` |
| `src/index.ts` | Action entry point — reads inputs, wires discover → score → report → threshold gating |
| `src/types.ts` | Shared types (`PackageScore`, `Thresholds`) |
| `action.yml` | Action metadata and inputs |
| `README.md` | Usage documentation |
