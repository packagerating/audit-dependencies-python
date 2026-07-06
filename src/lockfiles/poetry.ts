import { parse } from 'smol-toml'

interface PyprojectToml {
  tool?: {
    poetry?: {
      dependencies?: Record<string, unknown>
      'dev-dependencies'?: Record<string, unknown>
      group?: Record<string, { dependencies?: Record<string, unknown> }>
    }
  }
}

interface PoetryLock {
  package?: Array<{ name?: string; version?: string }>
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

export function collectPoetryDependencyNames(pyprojectContent: string): string[] {
  const parsed = parse(pyprojectContent) as PyprojectToml
  const poetry = parsed.tool?.poetry
  const names = new Set<string>()

  for (const name of Object.keys(poetry?.dependencies ?? {})) {
    if (name === 'python') continue
    names.add(name)
  }

  for (const name of Object.keys(poetry?.['dev-dependencies'] ?? {})) {
    names.add(name)
  }

  for (const group of Object.values(poetry?.group ?? {})) {
    for (const name of Object.keys(group.dependencies ?? {})) {
      names.add(name)
    }
  }

  return [...names]
}

export function resolvePoetryVersions(poetryLockContent: string, names: string[]): Map<string, string> {
  const parsed = parse(poetryLockContent) as PoetryLock
  const byNormalizedName = new Map<string, string>()

  for (const pkg of parsed.package ?? []) {
    if (pkg.name && pkg.version) {
      byNormalizedName.set(normalizeName(pkg.name), pkg.version)
    }
  }

  const resolved = new Map<string, string>()
  for (const name of names) {
    const version = byNormalizedName.get(normalizeName(name))
    if (version) resolved.set(name, version)
  }

  return resolved
}
