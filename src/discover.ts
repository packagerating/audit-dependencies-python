import * as fs from 'fs'
import * as path from 'path'
import { collectPoetryDependencyNames, resolvePoetryVersions } from './lockfiles/poetry'
import { parsePipfileLock } from './lockfiles/pipenv'
import { collectUvDependencyNames, resolveUvVersions } from './lockfiles/uv'
import { collectPdmDependencyNames, resolvePdmVersions } from './lockfiles/pdm'
import { discoverSubprojects } from './subprojects'

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

function resolveDirectory(dir: string, requirementsFileName: string): DiscoveredPackage[] {
  const poetryLockPath = path.join(dir, 'poetry.lock')
  if (fs.existsSync(poetryLockPath)) {
    const pyprojectPath = path.join(dir, 'pyproject.toml')
    const names = collectPoetryDependencyNames(fs.readFileSync(pyprojectPath, 'utf8'))
    const versions = resolvePoetryVersions(fs.readFileSync(poetryLockPath, 'utf8'), names)
    return names.map(name => ({ name, version: versions.get(name) ?? null }))
  }

  const pipfileLockPath = path.join(dir, 'Pipfile.lock')
  if (fs.existsSync(pipfileLockPath)) {
    return parsePipfileLock(fs.readFileSync(pipfileLockPath, 'utf8'))
  }

  const uvLockPath = path.join(dir, 'uv.lock')
  if (fs.existsSync(uvLockPath)) {
    const pyprojectPath = path.join(dir, 'pyproject.toml')
    const names = collectUvDependencyNames(fs.readFileSync(pyprojectPath, 'utf8'))
    const versions = resolveUvVersions(fs.readFileSync(uvLockPath, 'utf8'), names)
    return names.map(name => ({ name, version: versions.get(name) ?? null }))
  }

  const pdmLockPath = path.join(dir, 'pdm.lock')
  if (fs.existsSync(pdmLockPath)) {
    const pyprojectPath = path.join(dir, 'pyproject.toml')
    const names = collectPdmDependencyNames(fs.readFileSync(pyprojectPath, 'utf8'))
    const versions = resolvePdmVersions(fs.readFileSync(pdmLockPath, 'utf8'), names)
    return names.map(name => ({ name, version: versions.get(name) ?? null }))
  }

  return parseFile(path.join(dir, requirementsFileName), new Set())
}

export function discoverPackages(
  requirementsPath: string,
  explicitPackages: string[],
  auditSubprojects: boolean,
  subprojectMaxDepth: number,
  subprojectExcludeGlobs: string[],
): DiscoveredPackage[] {
  if (explicitPackages.length > 0) {
    return [...new Set(explicitPackages)].map(name => ({ name, version: null }))
  }

  const resolvedRequirementsPath = path.resolve(requirementsPath)
  const rootDir = path.dirname(resolvedRequirementsPath)
  const rootRequirementsFileName = path.basename(resolvedRequirementsPath)

  const all: DiscoveredPackage[] = [...resolveDirectory(rootDir, rootRequirementsFileName)]

  if (auditSubprojects) {
    for (const subprojectDir of discoverSubprojects(rootDir, subprojectMaxDepth, subprojectExcludeGlobs)) {
      all.push(...resolveDirectory(path.join(rootDir, subprojectDir), 'requirements.txt'))
    }
  }

  const byName = new Map<string, DiscoveredPackage>()
  for (const pkg of all) byName.set(pkg.name, pkg)
  return [...byName.values()]
}
