import { inspectJsonData, validateAgainst } from '@agnes/protocol'
import { PackageCatalogDescriptor } from '@agnes/protocol/gen/package-admin'
import { PackageError } from './errors.js'
import { checkCancelled } from './ports.js'
import { parseSource } from './sources.js'

export type CatalogSource = Readonly<{
  id: string
  load(signal: AbortSignal): Promise<unknown>
}>
export type CatalogSnapshot = Readonly<{
  sourceId: string
  issuedAt: string
  retrievedAt: string
  ttlMs: number
  entries: readonly PackageCatalogDescriptor[]
}>
export type CatalogRead = Readonly<{
  entries: readonly PackageCatalogDescriptor[]
  conflicts: readonly {
    id: string
    version: string
    selectedSourceId: string
    sourceIds: readonly string[]
    candidates: readonly PackageCatalogDescriptor[]
  }[]
  sources: readonly { sourceId: string; status: 'fresh' | 'cached' | 'unavailable' }[]
}>
const refuse = (): never => {
  throw new PackageError('E_DEP_MISSING', 'invalid catalog data')
}
const copy = <T>(value: T): T => structuredClone(value)
const timestamp = (value: unknown): number => {
  if (typeof value !== 'string') return refuse()
  const time = Date.parse(value)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) return refuse()
  return time
}
function validate(raw: unknown, sourceId: string, retrievedAt: string): CatalogSnapshot {
  const json = inspectJsonData(raw, 1024 * 1024)
  if (!json.ok || !json.value || typeof json.value !== 'object' || Array.isArray(json.value)) return refuse()
  const doc = json.value
  if (
    Object.keys(doc).some((key) => !['issuedAt', 'ttlMs', 'entries'].includes(key)) ||
    typeof doc.ttlMs !== 'number' ||
    !Number.isInteger(doc.ttlMs) ||
    doc.ttlMs < 1000 ||
    doc.ttlMs > 86400000 ||
    !Array.isArray(doc.entries) ||
    doc.entries.length > 1000 ||
    timestamp(doc.issuedAt) > timestamp(retrievedAt)
  )
    return refuse()
  const keys = new Set<string>()
  const entries = doc.entries.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse()
    const row = { ...value, sourceId, retrievedAt }
    const checked = validateAgainst<PackageCatalogDescriptor>(PackageCatalogDescriptor, row)
    if (!checked.ok) return refuse()
    const parsed = parseSource(checked.value.source.ref)
    if (parsed.type !== checked.value.source.type) return refuse()
    const key = `${checked.value.id}@${checked.value.version}`
    if (keys.has(key)) return refuse()
    keys.add(key)
    return checked.value
  })
  return { sourceId, issuedAt: doc.issuedAt as string, retrievedAt, ttlMs: doc.ttlMs, entries }
}
function fresh(snapshot: CatalogSnapshot, now: number): boolean {
  return (
    timestamp(snapshot.retrievedAt) <= now &&
    timestamp(snapshot.issuedAt) <= now &&
    now < Math.min(timestamp(snapshot.issuedAt), timestamp(snapshot.retrievedAt)) + snapshot.ttlMs
  )
}
async function load(source: CatalogSource, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted()
  let abort: () => void = () => {}
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('catalog read cancelled'))
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([Promise.resolve().then(() => source.load(signal)), stopped])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** Discovery only: this object has no package lock/store or activation ports. */
export function createCatalog(
  sources: readonly CatalogSource[],
  options: {
    priority: readonly string[]
    now?: () => number
    snapshots?: readonly unknown[]
  },
) {
  const now = options.now ?? Date.now
  const byId = new Map(sources.map((source) => [source.id, source]))
  if (
    sources.length > 32 ||
    byId.size !== sources.length ||
    sources.some((s) => !/^[a-z][a-z0-9-]{0,63}$/.test(s.id)) ||
    options.priority.length !== sources.length ||
    new Set(options.priority).size !== sources.length ||
    options.priority.some((id) => !byId.has(id))
  )
    return refuse()
  const priority = [...options.priority]
  let cache = new Map<string, CatalogSnapshot>()
  const clock = () => {
    const value = now()
    if (!Number.isSafeInteger(value) || value < 0) return refuse()
    return value
  }
  const initialNow = clock()
  if ((options.snapshots?.length ?? 0) > 32) return refuse()
  for (const raw of options.snapshots ?? []) {
    const json = inspectJsonData(raw, 1024 * 1024)
    if (!json.ok || !json.value || typeof json.value !== 'object' || Array.isArray(json.value))
      return refuse()
    const { sourceId, retrievedAt, ...doc } = json.value
    if (
      typeof sourceId !== 'string' ||
      !byId.has(sourceId) ||
      cache.has(sourceId) ||
      typeof retrievedAt !== 'string'
    )
      return refuse()
    const snapshot = validate(doc, sourceId, retrievedAt)
    if (timestamp(retrievedAt) > initialNow) return refuse()
    if (fresh(snapshot, initialNow)) cache.set(sourceId, snapshot)
  }
  let reading = false
  return Object.freeze({
    snapshots: (): readonly CatalogSnapshot[] => copy([...cache.values()]),
    async read(input: { offline?: boolean; signal?: AbortSignal } = {}): Promise<CatalogRead> {
      checkCancelled(input.signal)
      if (reading) throw new PackageError('E_EXT_LOAD', 'catalog read already active')
      reading = true
      try {
        const next = new Map(cache),
          statuses: CatalogRead['sources'][number][] = []
        const candidates = new Map<string, PackageCatalogDescriptor[]>()
        for (const sourceId of priority) {
          checkCancelled(input.signal)
          let snapshot = next.get(sourceId),
            status: 'fresh' | 'cached' | 'unavailable' = 'cached'
          if (!input.offline) {
            try {
              const signal = AbortSignal.any([
                ...(input.signal ? [input.signal] : []),
                AbortSignal.timeout(5000),
              ])
              const raw = await load(byId.get(sourceId) as CatalogSource, signal)
              const current = clock()
              const result = validate(raw, sourceId, new Date(current).toISOString())
              if (!fresh(result, current)) return refuse()
              snapshot = result
              next.set(sourceId, result)
              status = 'fresh'
            } catch {
              checkCancelled(input.signal)
            }
          }
          if (!snapshot || !fresh(snapshot, clock())) {
            status = 'unavailable'
            snapshot = undefined
          }
          statuses.push({ sourceId, status })
        }
        checkCancelled(input.signal)
        const publishedAt = clock()
        for (const status of statuses) {
          const snapshot = next.get(status.sourceId)
          if (!snapshot || !fresh(snapshot, publishedAt)) {
            status.status = 'unavailable'
            continue
          }
          for (const row of snapshot.entries) {
            const key = `${row.id}@${row.version}`
            candidates.set(key, [...(candidates.get(key) ?? []), row])
          }
        }
        const entries: PackageCatalogDescriptor[] = [],
          conflicts: CatalogRead['conflicts'][number][] = []
        for (const rows of candidates.values()) {
          const first = rows[0]
          if (!first) continue
          entries.push(first)
          if (rows.length > 1)
            conflicts.push({
              id: first.id,
              version: first.version,
              selectedSourceId: first.sourceId,
              sourceIds: rows.map((row) => row.sourceId),
              candidates: rows,
            })
        }
        cache = next
        return copy({ entries, conflicts, sources: statuses })
      } finally {
        reading = false
      }
    },
  })
}

/** Curated and customer static JSON use the same bounded, validated read contract. */
export function staticCatalogSource(
  id: string,
  read: (signal: AbortSignal) => Promise<unknown>,
): CatalogSource {
  return Object.freeze({ id, load: read })
}
