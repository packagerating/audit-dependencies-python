import { parse } from 'smol-toml'

interface PyprojectToml {
  project?: {
    dependencies?: string[]
  }
  'dependency-groups'?: Record<string, string[]>
  tool?: {
    pdm?: {
      'dev-dependencies'?: Record<string, string[]>
    }
  }
}

interface PdmLock {
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

export function collectPdmDependencyNames(pyprojectContent: string): string[] {
  const parsed = parse(pyprojectContent) as PyprojectToml
  const names = new Set<string>()

  for (const req of parsed.project?.dependencies ?? []) {
    const name = extractPackageName(req)
    if (name) names.add(name)
  }

  for (const group of Object.values(parsed['dependency-groups'] ?? {})) {
    for (const req of group) {
      const name = extractPackageName(req)
      if (name) names.add(name)
    }
  }

  for (const group of Object.values(parsed.tool?.pdm?.['dev-dependencies'] ?? {})) {
    for (const req of group) {
      const name = extractPackageName(req)
      if (name) names.add(name)
    }
  }

  return [...names]
}

export function resolvePdmVersions(pdmLockContent: string, names: string[]): Map<string, string> {
  const parsed = parse(pdmLockContent) as PdmLock
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
