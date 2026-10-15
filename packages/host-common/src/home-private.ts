import { closeSync, lstatSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import {
  createPrivateDirectorySync,
  createPrivateFileSync,
  hasPrivateDaclSync,
  windowsProtectPrivateDirectorySync,
  windowsProtectPrivateFileSync,
} from '@agnes/system-node'

const unsafe = () => Object.assign(new Error('E_HOME_UNSAFE'), { code: 'E_HOME_UNSAFE' })
function existingHomeObject(path: string) {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Check traversal without changing existing ancestors outside the initialization boundary. */
function checkAncestors(path: string): void {
  const parent = dirname(path)
  if (parent !== path) checkAncestors(parent)
  const stat = existingHomeObject(path)
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw unsafe()
}

/** Only known initialization objects may freeze already-private inherited access. */
function protectHomeObject(path: string, kind: 'directory' | 'file'): void {
  const stat = lstatSync(path)
  if (
    stat.isSymbolicLink() ||
    (kind === 'directory' ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
  )
    throw unsafe()
  if (!hasPrivateDaclSync(path)) {
    if (kind === 'directory') windowsProtectPrivateDirectorySync(path)
    else windowsProtectPrivateFileSync(path)
    if (!hasPrivateDaclSync(path)) throw unsafe()
  }
}

/** Two passes: reject unsafe existing objects before creating missing initialization directories. */
export function prepareWindowsHomeDirectories(home: string, paths: readonly string[], marker?: string): void {
  const root = resolve(home)
  const directories = new Set<string>([root])
  for (const path of paths) {
    const missing: string[] = []
    let cursor = resolve(path)
    while (cursor !== root && !existingHomeObject(cursor)) {
      missing.push(cursor)
      const parent = dirname(cursor)
      if (parent === cursor) throw unsafe()
      cursor = parent
    }
    // Include existing intermediate directories inside home, but not unrelated external parents.
    const fromHome = relative(root, cursor)
    if (!isAbsolute(fromHome) && fromHome !== '..' && !fromHome.startsWith(`..${sep}`)) {
      for (;;) {
        directories.add(cursor)
        if (relative(root, cursor) === '') break
        cursor = dirname(cursor)
      }
    }
    directories.add(resolve(path))
    for (const directory of missing.reverse()) directories.add(directory)
  }
  const ordered = [...directories].sort((a, b) => a.length - b.length)
  for (const directory of ordered) {
    checkAncestors(directory)
    if (existingHomeObject(directory)) protectHomeObject(directory, 'directory')
  }
  if (marker) protectHomeObject(marker, 'file')
  for (const directory of ordered) {
    createHomeDirectory(directory)
    protectHomeObject(directory, 'directory')
  }
}

/** Missing parents are created privately; existing external parents are only checked for traversal. */
export function createHomeDirectory(path: string): void {
  checkAncestors(path)
  if (existingHomeObject(path)) return
  const parent = dirname(path)
  if (parent === path) throw unsafe()
  if (!existingHomeObject(parent)) createHomeDirectory(parent)
  try {
    createPrivateDirectorySync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    protectHomeObject(path, 'directory')
  }
}

export function prepareHomeLock(file: string): void {
  checkAncestors(dirname(file))
  try {
    closeSync(createPrivateFileSync(file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  protectHomeObject(file, 'file')
}
