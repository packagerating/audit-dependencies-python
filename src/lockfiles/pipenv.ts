import type { DiscoveredPackage } from '../discover'

interface PipfileLockPackage {
  version?: string
}

interface PipfileLock {
  default?: Record<string, PipfileLockPackage>
  develop?: Record<string, PipfileLockPackage>
}

export function parsePipfileLock(pipfileLockContent: string): DiscoveredPackage[] {
  const parsed = JSON.parse(pipfileLockContent) as PipfileLock
  const byName = new Map<string, DiscoveredPackage>()

  for (const [name, pkg] of Object.entries(parsed.develop ?? {})) {
    if (!pkg.version) continue
    byName.set(name, { name, version: pkg.version.replace(/^==/, '') })
  }

  for (const [name, pkg] of Object.entries(parsed.default ?? {})) {
    if (!pkg.version) continue
    byName.set(name, { name, version: pkg.version.replace(/^==/, '') })
  }

  return [...byName.values()]
}
