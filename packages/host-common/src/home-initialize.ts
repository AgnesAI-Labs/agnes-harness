import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { HOME_LAYOUT_VERSION, inspectHome } from './home-layout.js'

const MARKER = 'home-layout.json'
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

/** Create only missing directories; never silently repairs permissions on an existing home. */
function directory(path: string, boundary?: string): void {
  if (boundary && path !== boundary) directory(dirname(path), boundary)
  if (present(path)) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw homeFault('E_HOME_UNSAFE')
    return
  }
  if (!present(dirname(path))) directory(dirname(path))
  mkdirSync(path, { mode: 0o700 })
}
function publishMarker(home: string): void {
  const temporary = join(home, `.home-layout-${randomUUID()}.tmp`)
  writeFileSync(
    temporary,
    JSON.stringify({ version: HOME_LAYOUT_VERSION, instanceId: randomUUID() }) + '\n',
    { flag: 'wx', mode: 0o600 },
  )
  renameSync(temporary, join(home, MARKER))
}
export function initializeHome(home: string, profile = 'local-dev') {
  const info = inspectHome(home, profile)
  if (info.state === 'unsupported') throw homeFault('E_HOME_VERSION')
  directory(home)
  // PackageManager remains the only writer of the live package store.
  for (const path of Object.values(info.paths).filter((path) => path !== info.paths.packages))
    directory(path, resolve(home))
  if (info.version === null) publishMarker(home)
  return inspectHome(home, profile)
}
