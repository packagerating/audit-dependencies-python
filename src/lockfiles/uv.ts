import { parse } from 'smol-toml'

interface PyprojectToml {
  project?: {
    dependencies?: string[]
  }
  'dependency-groups'?: Record<string, string[]>
  tool?: {
    uv?: {
      'dev-dependencies'?: string[]
    }
  }
}

interface UvLock {
  package?: Array<{ name?: string; version?: string }>
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

function extractPackageName(requirementString: string): string | null {
  const withoutMarker = requirementString.split(';')[0]!.trim()
  if (!withoutMarker) return null

  const nameMatch = withoutMarker.match(/^([^[=><~!]+)/)
  if (!nameMatch) return null

  const name = nameMatch[1]!.trim()
  return name || null
}

export function collectUvDependencyNames(pyprojectContent: string): string[] {
  const parsed = parse(pyprojectContent) as PyprojectToml
  const names = new Set<string>()

  for (const req of parsed.project?.dependencies ?? []) {
    const name = extractPackageName(req)
    if (name) names.add(name)
  }

  for (const req of parsed.tool?.uv?.['dev-dependencies'] ?? []) {
    const name = extractPackageName(req)
    if (name) names.add(name)
  }

  for (const group of Object.values(parsed['dependency-groups'] ?? {})) {
    for (const req of group) {
      const name = extractPackageName(req)
      if (name) names.add(name)
    }
  }

  return [...names]
}

export function resolveUvVersions(uvLockContent: string, names: string[]): Map<string, string> {
  const parsed = parse(uvLockContent) as UvLock
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
