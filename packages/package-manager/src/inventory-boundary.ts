import { statSync } from 'node:fs'
import { join } from 'node:path'

// Small policy/lock files are change sentinels ONLY for joining a pending scan, never authority
// for skipping byte verification. A scan itself always reads current policy; installed bytes are
// re-read unless hashDirectory's file size/mtime/inode signature is unchanged (sources.ts).
export const readBoundary = (
  directory: string,
  files = ['agnes-lock.json', 'plugin-capabilities.json', 'package-sources.json'],
): string =>
  files
    .map((file) => {
      try {
        const stat = statSync(join(directory, file), { bigint: true })
        return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
        throw error
      }
    })
    .join('|')
