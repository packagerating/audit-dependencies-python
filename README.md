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
