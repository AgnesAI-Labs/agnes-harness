import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Archive a package with independent file inodes. COPYFILE_FICLONE uses copy-on-write where
 * supported and otherwise copies bytes; retry a plain copy if the clone request itself fails.
 * Avoid fs.cpSync, which terminates Node on Windows for Unicode source paths.
 */
export function clonePackageTreeSync(source: string, destination: string): void {
  const stat = lstatSync(source)
  if (stat.isDirectory()) {
    mkdirSync(destination, { mode: stat.mode | 0o700 })
    for (const name of readdirSync(source)) clonePackageTreeSync(join(source, name), join(destination, name))
    chmodSync(destination, stat.mode)
    return
  }
  if (!stat.isFile()) throw new Error('package tree contains a link or special entry')
  try {
    copyFileSync(source, destination, constants.COPYFILE_FICLONE)
  } catch {
    copyFileSync(source, destination)
  }
  chmodSync(destination, stat.mode)
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
