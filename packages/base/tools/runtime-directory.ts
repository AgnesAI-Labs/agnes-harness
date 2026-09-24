import { lstat, mkdir, mkdtemp, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

async function move(from: string, to: string): Promise<void> {
  const deadline = performance.now() + 1_000
  for (;;) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (
        process.platform !== 'win32' || // guards-allow-platform: Windows build artifacts can remain briefly held after exit.
        !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') ||
        performance.now() >= deadline
      )
        throw error
      await delay(20)
    }
  }
}

/** Build-output transaction. A leftover lock is never stolen or automatically deleted. */
export async function beginRuntimeDirectory(output: string) {
  const root = resolve(output)
  const lock = `${root}.build-lock`
  await mkdir(dirname(root), { recursive: true })
  try {
    await mkdir(lock)
  } catch (cause) {
    throw new Error(
      `Runtime output is locked or unavailable; inspect ${lock} before retrying. Confirm no builder is using it; preserve previous and staging output. See docs/guide/build-recovery.md`,
      { cause },
    )
  }
  let staging: string
  try {
    staging = await mkdtemp(`${root}.tmp-`)
  } catch (cause) {
    await rmdir(lock)
    throw cause
  }
  const previous = join(lock, 'previous')
  let preserve = false
  return {
    staging,
    async commit(): Promise<void> {
      let hadPrevious = false
      try {
        const stat = await lstat(root)
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error('Runtime output must be a real directory')
        hadPrevious = true
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      }
      if (hadPrevious) await move(root, previous)
      try {
        await move(staging, root)
      } catch (cause) {
        if (hadPrevious) {
          try {
            await move(previous, root)
          } catch (rollback) {
            preserve = true
            throw new AggregateError(
              [cause, rollback],
              `Runtime publication and restore failed; previous output retained at ${previous}`,
            )
          }
        }
        throw cause
      }
      if (hadPrevious) {
        try {
          await rm(previous, { recursive: true })
        } catch (cause) {
          preserve = true
          throw new Error(`Runtime output committed, but old-output cleanup failed; inspect ${previous}`, {
            cause,
          })
        }
      }
    },
    async dispose(): Promise<void> {
      await rm(staging, { recursive: true, force: true })
      if (!preserve) await rmdir(lock)
    },
  }
}
