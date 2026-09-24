import type { EventEnvelope } from '../gen/ts/session-v1.js'
import { isEventType } from './constants.js'

export const CURRENT_V = 1
type Up = (data: unknown) => unknown
const table = new Map<string, Up>() // key `${type}@${fromV}`

// `register` / `supported` used to occupy the root export. Both names are extremely generic:
// extension-api's API surface is four `register*` functions, so a bare `register` imported from
// another package gets read as "register an extension". Renamed to registerMigration /
// supportedVersions — the functions themselves, not aliased in index, so two names never coexist.
export function registerMigration(type: string, fromV: number, up: Up): void {
  const key = `${type}@${fromV}`
  if (table.has(key)) throw new Error(`duplicate migration ${key}`)
  if (fromV >= CURRENT_V) throw new Error(`migration ${key} must target a past version`)
  table.set(key, up)
}

// A read-only view of what is registered, so the fixture gate can ask the registry rather than be
// handed a list somebody keeps by hand. Unlike resetMigrations this is safe on the root surface: it
// mutates nothing.
export function listMigrations(): Array<{ type: string; fromV: number }> {
  return [...table.keys()].map((k) => {
    const i = k.lastIndexOf('@')
    return { type: k.slice(0, i), fromV: Number(k.slice(i + 1)) }
  })
}

export function resetMigrations(): void {
  table.clear()
}

// `resetMigrations` is a test back door that clears a module-level global Map and is deliberately
// **not** on the root export (src/index.ts explains why: any package could wipe the process-wide
// migration registry at runtime by calling it).
// Noted but not addressed: `table` is a module-level singleton, so a daemon process hosting several
// sessions / Profiles shares one table process-wide. With only one version defined the table is
// always empty, so there is no impact yet.
export function supportedVersions(): { min: number; current: number } {
  let min = CURRENT_V
  for (const key of table.keys()) min = Math.min(min, Number(key.split('@')[1]))
  return { min, current: CURRENT_V }
}

export function normalize(event: EventEnvelope): EventEnvelope {
  if (!isEventType(event.type) && event.ignorable !== true) throw new Error(`E_UNKNOWN_EVENT: ${event.type}`)
  let v = event.v ?? CURRENT_V
  if (v > CURRENT_V) throw new Error(`E_UNSUPPORTED_VERSION: ${v} > ${CURRENT_V}`)
  let data = event.data
  while (v < CURRENT_V) {
    const up = table.get(`${event.type}@${v}`)
    if (!up) throw new Error(`E_UNSUPPORTED_VERSION: no migration ${event.type}@${v}`)
    data = up(data) as EventEnvelope['data']
    v++
  }
  return { ...event, v, data }
}
