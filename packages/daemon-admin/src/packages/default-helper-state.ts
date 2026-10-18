import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_BUNDLED_PACKAGES, withLock } from '@agnes/package-manager'

export type DefaultHelperState = {
  phase: 'pending' | 'installed' | 'complete' | 'existing'
  integrity: Record<string, string>
} & ({ version: 1 | 2 | 3 } | { version: 4; offered: string[] })

// The October 17 local distribution used v4 before the offered field was added.
// Its version-based writer had already offered these seven defaults. Keep this
// historical list fixed: using today's catalog would hide newly shipped plugins.
const legacyV4Offers = [
  '@agnes/skill-helper',
  '@agnes/mcp-helper',
  '@agnes/plugin-helper',
  '@agnes/goal-ui',
  '@agnes/interaction-ui',
  '@agnes/deliverables-ui',
  '@agnes/document-reader',
]

function decode(raw: unknown): DefaultHelperState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid helper initialization record')
  let s = raw as Record<string, unknown>
  if (s.version === 4 && Object.keys(s).sort().join(',') === 'integrity,phase,version') {
    if (
      s.integrity &&
      typeof s.integrity === 'object' &&
      Object.keys(s.integrity).some((id) => !legacyV4Offers.includes(id))
    )
      throw new Error('Invalid legacy helper integrity record')
    s = { ...s, offered: [...legacyV4Offers] }
  }
  if (
    Object.keys(s).sort().join(',') !==
      (s.version === 4 ? 'integrity,offered,phase,version' : 'integrity,phase,version') ||
    (s.version !== 1 && s.version !== 2 && s.version !== 3 && s.version !== 4) ||
    typeof s.phase !== 'string' ||
    !['pending', 'installed', 'complete', 'existing'].includes(s.phase) ||
    !s.integrity ||
    typeof s.integrity !== 'object' ||
    Array.isArray(s.integrity)
  )
    throw new Error('Invalid helper initialization record')
  const integrity = s.integrity as Record<string, unknown>
  if (
    Object.entries(integrity).some(
      ([id, hash]) =>
        !DEFAULT_BUNDLED_PACKAGES.some((h) => h.id === id) ||
        typeof hash !== 'string' ||
        !/^sha256-[a-f0-9]{64}$/.test(hash),
    )
  )
    throw new Error('Invalid helper integrity record')
  if (
    s.version === 4 &&
    (s.phase === 'existing' ||
      !Array.isArray(s.offered) ||
      s.offered.some((id) => !DEFAULT_BUNDLED_PACKAGES.some((helper) => helper.id === id)) ||
      new Set(s.offered).size !== s.offered.length ||
      Object.keys(integrity).some((id) => !(s.offered as unknown[]).includes(id)))
  )
    throw new Error('Invalid helper offered record')
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
    const raw: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
    const state = raw === undefined ? undefined : decode(raw)
    const save = (next: DefaultHelperState) => {
      const temp = `${file}.${randomUUID()}.tmp`
      writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flush: true })
      renameSync(temp, file)
    }
    // Persist only after full validation, under the same lock and atomic write as ordinary receipts.
    if (state?.version === 4 && !Object.hasOwn(raw as object, 'offered')) save(state)
    await run(state, save)
  })
}
