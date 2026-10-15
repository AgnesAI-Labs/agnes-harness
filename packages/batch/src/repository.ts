import { createHash } from 'node:crypto'
import {
  BatchError,
  type Input,
  type Item,
  type Json,
  type Manifest,
  type Spec,
  type Store,
  type StoreTransaction,
} from './contracts.js'
import { validateSpec } from './schema.js'

export const batchKey = (id: string) => `manifest/${checkId(id)}`
export function checkId(id: string): string {
  if (!/^b[0-9a-f]{12}$/u.test(id)) throw new BatchError('E_BATCH_ID')
  return id
}
export const itemKey = (id: string, ordinal: number) =>
  `batch/${checkId(id)}/item/${ordinal.toString().padStart(6, '0')}`
export function load<T>(tx: StoreTransaction, key: string): T {
  const row = tx.get(key)
  if (!row) throw new BatchError('E_BATCH_NOT_FOUND')
  return structuredClone(row.value) as T
}
export function save(tx: StoreTransaction, key: string, value: Manifest | Item): void {
  tx.put(key, JSON.parse(JSON.stringify(value)) as Json, tx.get(key)?.revision ?? null)
}
export class Repository {
  constructor(readonly store: Store) {}
  async begin(id: string, input: Spec, inputs: readonly Input[], now: number): Promise<Manifest> {
    checkId(id)
    const spec = validateSpec(input)
    if (!Number.isFinite(now) || inputs.length < 1 || inputs.length > 100_000)
      throw new BatchError('E_BATCH_INPUTS')
    const files = structuredClone([...inputs]).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )
    const names = new Set<string>()
    for (const file of files) {
      if (
        !file.name ||
        Buffer.byteLength(file.name) > 1024 ||
        /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(file.name) ||
        file.name.startsWith('/') ||
        file.name.includes('\\') ||
        file.name.split('/').some((p) => !p || p === '.' || p === '..') ||
        !/^[a-f0-9]{64}$/u.test(file.digest) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > 20 * 1024 * 1024 ||
        !file.artifact ||
        Buffer.byteLength(file.artifact) > 1024 ||
        names.has(file.name)
      )
        throw new BatchError('E_BATCH_INPUTS')
      names.add(file.name)
    }
    const digest = createHash('sha256').update(JSON.stringify({ spec, files })).digest('hex')
    return this.store.transaction((tx) => {
      const key = batchKey(id)
      if (tx.get(key)) {
        const old = load<Manifest>(tx, key)
        if (old.digest !== digest) throw new BatchError('E_BATCH_ID_CONFLICT')
        return old
      }
      const manifest: Manifest = {
        version: 1,
        id,
        digest,
        spec,
        created: now,
        status: 'running',
        total: files.length,
        next: 1,
        settled: 0,
        successes: 0,
        failures: 0,
        spent: 0,
        reserved: 0,
        uncertain: 0,
        active: [],
        resultBytes: 0,
      }
      save(tx, key, manifest)
      for (const [index, file] of files.entries())
        save(tx, itemKey(id, index + 1), {
          ordinal: index + 1,
          input: file,
          state: 'pending',
          attempts: [],
        })
      return manifest
    })
  }
  async list(cursor?: string): Promise<{ rows: Manifest[]; nextCursor?: string }> {
    const page = await this.store.scan({ prefix: 'manifest/', limit: 100, ...(cursor ? { cursor } : {}) })
    return {
      rows: page.rows.map((row) => structuredClone(row.value) as unknown as Manifest),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    }
  }
  status(id: string): Promise<Manifest> {
    return this.store.transaction((tx) => load<Manifest>(tx, batchKey(id)))
  }
  page(id: string, offset = 0, limit = 100): Promise<Item[]> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new BatchError('E_BATCH_PAGE')
    return this.store.transaction((tx) => {
      const m = load<Manifest>(tx, batchKey(id))
      return Array.from({ length: Math.min(limit, Math.max(0, m.total - offset)) }, (_, i) =>
        load<Item>(tx, itemKey(id, offset + i + 1)),
      )
    })
  }
}
