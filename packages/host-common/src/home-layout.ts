import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { cacheDir, dataDir, fileSecretsDir } from './paths.js'

export const HOME_LAYOUT_VERSION = 1
const MARKER = 'home-layout.json'
/** The single supported home layout. */
export function homeLayout(home: string, profile = 'local-dev') {
  if (!isAbsolute(home) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(profile))
    throw homeFault('E_HOME_INVALID')
  return {
    config: join(home, 'profiles', profile),
    credentials: fileSecretsDir(home),
    oauth: join(home, 'auth'),
    ledger: dataDir(home),
    packages: join(dataDir(home), 'profiles', profile, 'packages'),
    generations: join(home, 'profiles', profile, '.runtime-generations'),
    logs: join(dataDir(home), 'audit'),
    audit: join(dataDir(home), 'audit'),
    diagnostics: join(home, 'diagnostics'),
    cache: cacheDir(home),
    tmp: join(home, 'tmp'),
  }
}
const homeFault = (code: string) => Object.assign(new Error(code), { code })
const present = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
/** Read-only inspection; never guesses whether another product's home belongs to AGH. */
export function inspectHome(home: string, profile = 'local-dev') {
  const paths = homeLayout(home, profile)
  if (present(home) && (!lstatSync(home).isDirectory() || lstatSync(home).isSymbolicLink()))
    throw homeFault('E_HOME_UNSAFE')
  for (const path of [dataDir(home), join(home, 'profiles'), join(home, 'profiles', profile)]) {
    if (present(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()))
      throw homeFault('E_HOME_UNSAFE')
  }
  let version: number | null = null
  let instanceId: string | undefined
  const marker = join(home, MARKER)
  if (present(marker)) {
    const stat = lstatSync(marker)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096)
      throw homeFault('E_HOME_UNSAFE')
    let value: unknown
    try {
      value = JSON.parse(readFileSync(marker, 'utf8'))
    } catch {
      throw homeFault('E_HOME_VERSION')
    }
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== HOME_LAYOUT_VERSION)
      throw homeFault('E_HOME_VERSION')
    if (
      'instanceId' in value &&
      typeof value.instanceId === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.instanceId)
    )
      instanceId = value.instanceId
    version = HOME_LAYOUT_VERSION
  }
  const occupied = version === null && present(home) && readdirSync(home).length > 0
  return {
    home,
    profile,
    version,
    instanceId,
    state: version === 1 ? 'current' : occupied ? 'unsupported' : 'fresh',
    paths,
  }
}
