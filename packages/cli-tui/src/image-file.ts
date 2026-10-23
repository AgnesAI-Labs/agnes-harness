import { statSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

/** An absolute path to an existing regular file (a symlink is followed) with an image extension the model reads. */
export function isLocalImageFile(path: string): boolean {
  if (!isAbsolute(path) || !IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) return false
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
