import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The version whose full welcome this CLI state directory has already shown; unreadable reads as never. */
export function readWelcomeSeen(path?: string): string | undefined {
  try {
    const version: unknown = JSON.parse(readFileSync(path ?? '', 'utf8')).version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

/** Best effort: a failed write only means the next launch shows the full welcome again. */
export function saveWelcomeSeen(path: string | undefined, version: string): void {
  if (!path) return
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify({ version })}\n`, { mode: 0o600 })
    renameSync(temporary, path)
  } catch {
    /* Ignored: see above. */
  } finally {
    try {
      rmSync(temporary, { force: true })
    } catch {
      /* Best-effort temporary cleanup. */
    }
  }
}
