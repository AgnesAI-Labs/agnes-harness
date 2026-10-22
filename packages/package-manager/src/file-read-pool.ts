/** Overlap verified file IO with bounded handles/scratch memory and deterministic digest order. */
export async function hashFileReads<T>(
  files: readonly T[],
  read: (file: T, chunk: Uint8Array) => Promise<Buffer>,
): Promise<Buffer[]> {
  return mapFiles(files, () => {
    const chunk = new Uint8Array(256 * 1024)
    return (file) => read(file, chunk)
  })
}

/** Bound metadata checks too; all started checks settle before any error is returned. */
export function mapFileChecks<T, R>(files: readonly T[], check: (file: T) => Promise<R>): Promise<R[]> {
  return mapFiles(files, () => check)
}

/** Visit one directory level at a time, draining every started check before advancing or refusing. */
export async function walkFileChecks<T>(
  roots: readonly T[],
  visit: (directory: T) => Promise<readonly T[]>,
): Promise<void> {
  let level = roots
  while (level.length) level = (await mapFileChecks(level, visit)).flat()
}

async function mapFiles<T, R>(files: readonly T[], createRead: () => (file: T) => Promise<R>): Promise<R[]> {
  const digests: R[] = []
  let next = 0
  let failed = false
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(4, files.length) }, async () => {
      const read = createRead()
      while (!failed) {
        const index = next++
        const file = files[index]
        if (file === undefined) return
        try {
          digests[index] = await read(file)
        } catch (error) {
          failed = true
          throw error
        }
      }
    }),
  )
  for (const result of workers) if (result.status === 'rejected') throw result.reason
  return digests
}
