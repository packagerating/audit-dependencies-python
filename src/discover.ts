import * as fs from 'fs'
import * as path from 'path'

export interface DiscoveredPackage {
  name: string
  version: string | null
}

function isRequirementInclude(trimmed: string): string | null {
  const match = trimmed.match(/^(?:-r|--requirement)(?:\s+|=)(.+)$/)
  return match ? match[1]!.trim() : null
}

function isVcsOrUrl(trimmed: string): boolean {
  if (trimmed.includes('://')) return true
  if (/^(git|hg|svn|bzr)\+/.test(trimmed)) return true
  if (trimmed.startsWith('.') || trimmed.startsWith('/')) return true
  return false
}

function parseRequirementLine(trimmed: string): DiscoveredPackage | null {
  const withoutMarker = trimmed.split(';')[0]!.trim()
  if (!withoutMarker) return null

  const nameMatch = withoutMarker.match(/^([^[=><~!]+)/)
  if (!nameMatch) return null
  const name = nameMatch[1]!.trim()
  if (!name) return null

  let rest = withoutMarker.slice(nameMatch[0].length).trim()

  if (rest.startsWith('[')) {
    const closeIdx = rest.indexOf(']')
    if (closeIdx === -1) return { name, version: null }
    rest = rest.slice(closeIdx + 1).trim()
  }

  const versionMatch = rest.match(/^==([\w.\-+]+)$/)
  return { name, version: versionMatch ? versionMatch[1]! : null }
}

function parseFile(filePath: string, seen: Set<string>): DiscoveredPackage[] {
  const resolvedPath = path.resolve(filePath)
  if (seen.has(resolvedPath)) return []
  seen.add(resolvedPath)

  const content = fs.readFileSync(resolvedPath, 'utf8')
  const results: DiscoveredPackage[] = []

  for (const rawLine of content.split('\n')) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const includePath = isRequirementInclude(trimmed)
    if (includePath) {
      const includeFullPath = path.resolve(path.dirname(resolvedPath), includePath)
      results.push(...parseFile(includeFullPath, seen))
      continue
    }

    if (trimmed.startsWith('-')) continue
    if (isVcsOrUrl(trimmed)) continue

    const pkg = parseRequirementLine(trimmed)
    if (pkg) results.push(pkg)
  }

  return results
}

export function discoverPackages(requirementsPath: string, explicitPackages: string[]): DiscoveredPackage[] {
  if (explicitPackages.length > 0) {
    return [...new Set(explicitPackages)].map(name => ({ name, version: null }))
  }

  const all = parseFile(requirementsPath, new Set())

  const byName = new Map<string, DiscoveredPackage>()
  for (const pkg of all) byName.set(pkg.name, pkg)
  return [...byName.values()]
}
