import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

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
