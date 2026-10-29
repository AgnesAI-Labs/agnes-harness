import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { ImportError, MAX_IMPORT_BYTES } from '@agnes/bridges/convert'

/** A bounded regular-file read: refuse devices/FIFOs and files that grow past the limit. */
export function readImportFile(path: string): Uint8Array {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error('import source must be a regular file')
    const tooLarge = () => new ImportError('E_IMPORT_TOO_LARGE', 'source exceeds 64 MiB')
    if (stat.size > MAX_IMPORT_BYTES) throw tooLarge()
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_IMPORT_BYTES + 1 - total))
      const count = readSync(fd, chunk)
      if (!count) break
      total += count
      if (total > MAX_IMPORT_BYTES) throw tooLarge()
      chunks.push(chunk.subarray(0, count))
    }
    return Buffer.concat(chunks, total)
  } finally {
    closeSync(fd)
  }
}
