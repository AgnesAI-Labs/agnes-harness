import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUNDLED_HELPERS, withLock } from '@agnes/package-manager'

export type DefaultHelperState = {
  version: 1 | 2
  phase: 'pending' | 'installed' | 'complete' | 'existing'
  integrity: Record<string, string>
}
function decode(raw: unknown): DefaultHelperState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid helper initialization record')
  const s = raw as Record<string, unknown>
  if (
    Object.keys(s).sort().join(',') !== 'integrity,phase,version' ||
    (s.version !== 1 && s.version !== 2) ||
    !['pending', 'installed', 'complete', 'existing'].includes(String(s.phase)) ||
    !s.integrity ||
    typeof s.integrity !== 'object' ||
    Array.isArray(s.integrity)
  )
    throw new Error('Invalid helper initialization record')
  const integrity = s.integrity as Record<string, unknown>
  if (
    Object.entries(integrity).some(
      ([id, hash]) =>
        !BUNDLED_HELPERS.some((h) => h.id === id) ||
        typeof hash !== 'string' ||
        !/^sha256-[a-f0-9]{64}$/.test(hash),
    )
  )
    throw new Error('Invalid helper integrity record')
  if (s.phase === 'installed' && !Object.keys(integrity).length)
    throw new Error('Empty helper activation record')
  return s as DefaultHelperState
}

/** Owns only the daemon bootstrap receipt, never package-manager storage. */
export async function withDefaultHelperState(
  profileDir: string,
  run: (state: DefaultHelperState | undefined, save: (state: DefaultHelperState) => void) => Promise<void>,
): Promise<void> {
  const directory = join(profileDir, 'default-helpers')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  await withLock(directory, async () => {
    const file = join(directory, 'state.json')
    const state = existsSync(file) ? decode(JSON.parse(readFileSync(file, 'utf8'))) : undefined
    await run(state, (next) => {
      const temp = `${file}.${randomUUID()}.tmp`
      writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flush: true })
      renameSync(temp, file)
    })
  })
}
