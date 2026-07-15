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
