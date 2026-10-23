import { chmodSync, copyFileSync, linkSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Mirror an immutable package tree with hard links: fresh directories, so each copy keeps its own
 * paths (and module identities), sharing file contents with the source. A file that cannot be linked
 * (another volume, a filesystem without links) is copied instead. Returns whether every file was linked.
 */
export function linkPackageTreeSync(source: string, destination: string): boolean {
  const stat = lstatSync(source)
  if (stat.isDirectory()) {
    mkdirSync(destination, { mode: stat.mode | 0o700 })
    let linked = true
    for (const name of readdirSync(source))
      linked = linkPackageTreeSync(join(source, name), join(destination, name)) && linked
    chmodSync(destination, stat.mode)
    return linked
  }
  if (!stat.isFile()) throw new Error('package tree contains a link or special entry')
  try {
    linkSync(source, destination)
    return true
  } catch {
    copyFileSync(source, destination)
    chmodSync(destination, stat.mode)
    return false
  }
}

/** Copy a verified package tree without fs.cpSync, which terminates Node on Windows when the source path is Unicode. */
export function copyPackageTreeSync(
  source: string,
  destination: string,
  filter: (path: string) => boolean = () => true,
): void {
  if (!filter(source)) return
  const stat = lstatSync(source)
  if (stat.isDirectory()) {
    // A read-only source directory still needs to accept its children during the copy.
    mkdirSync(destination, { mode: stat.mode | 0o700 })
    for (const name of readdirSync(source))
      copyPackageTreeSync(join(source, name), join(destination, name), filter)
    chmodSync(destination, stat.mode)
  } else if (stat.isFile()) {
    copyFileSync(source, destination)
    chmodSync(destination, stat.mode)
  } else throw new Error('package tree contains a link or special entry')
}
