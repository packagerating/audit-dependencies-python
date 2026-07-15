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
| `audit-subprojects` | `true` | Discover and score independent Python projects in subdirectories (each with their own manifest and lockfile) |
| `subproject-max-depth` | `3` | Maximum directory depth below repo root to scan for independent Python project roots |
| `subproject-exclude` | — | Comma-separated additional glob patterns to exclude from subproject discovery |
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

If the root and a subproject depend on genuinely different versions of the same package, only one
version is scored — the combined package list is deduplicated by name only, last-resolved wins
(subprojects are resolved after the root). This differs from per-source version tracking; if your
subprojects intentionally pin different versions of a shared dependency, be aware only one of those
versions will appear in the report.

## Out of scope

- **Per-subproject attribution in the report** — the report doesn't indicate which subproject (or
  the root) a given package came from, just the deduplicated, combined list.
- **Nested subprojects** — a discovered subproject that itself contains further nested manifests
  within `subproject-max-depth` is treated as its own independent leaf, with no special handling
  for a subproject-within-a-subproject.
- **uv's formal `[tool.uv.workspace]` declaration** — uv's own workspace protocol is a distinct
  mechanism from the independent-subproject discovery this action performs; a `[tool.uv.workspace]`
  declaration is not specially detected or honored.
