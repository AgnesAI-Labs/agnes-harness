import { createHash } from 'node:crypto'
import { jcs } from '@agnes/protocol'
import type { AuthorityExportPart, BlobRef, DataRef, JsonValue } from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'

export const EXPORT_INDEX = 'agh.migration/export-index@1'
export const ASSET_INDEX = 'agh.migration/asset-index@1'
export const INDEX_MAX_ITEMS = 500
export const INDEX_MAX_BYTES = 1024 * 1024
// Keep normal pages below V8 large-object allocations; the wire ceiling still permits 1 MiB.
const PAGE_TARGET_BYTES = 64 * 1024
const MAX_DEPTH = 32
const MAX_ITEM_BYTES = 16 * 1024 * 1024
export type IndexType = typeof EXPORT_INDEX | typeof ASSET_INDEX
export type IndexItem = AuthorityExportPart | DataRef

/** Storage must return immutable, content-addressed bytes. Reads are independently checked. */
export interface IndexStorage {
  put(bytes: Uint8Array, typeId: string): Promise<DataRef>
  read(blob: BlobRef): AsyncIterable<Uint8Array>
}
interface Entry {
  key: string
  item?: IndexItem
  itemRef?: DataRef
}
interface Branch {
  firstKey: string
  lastKey: string
  count: number
  child: DataRef
}
interface IndexNode {
  typeId: IndexType
  level: number
  entries: Entry[] | Branch[]
}
interface IndexRow {
  key: string
  item: IndexItem
  position: number
  descriptor?: DataRef
}
export interface IndexCheckpoint {
  version: 1
  typeId: IndexType
  manifestDigest: string
  fenceDigest: string
  after: string | null
  consumed: number
}
export class ExportIndexError extends Error {
  constructor(readonly detailCode: string) {
    super(`Migration index refused: ${detailCode}`)
  }
}
const refuse = (code: string): never => {
  throw new ExportIndexError(code)
}
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue
const encoded = (value: unknown): Buffer => Buffer.from(jcs(value as JsonValue))
export const indexDigest = (ref: DataRef): string => (ref.kind === 'inline' ? ref.digest : ref.blob.digest)

export function indexItemKey(typeId: IndexType, item: IndexItem): string {
  if (typeId === EXPORT_INDEX) {
    if (!validateRuntime('AuthorityExportPart', item).ok) refuse('part_schema')
    const part = item as AuthorityExportPart
    if (
      part.chunk.digest !== part.contentDigest ||
      part.chunk.bytes > 1024 ** 3 ||
      Buffer.compare(Buffer.from(part.firstRecordKey), Buffer.from(part.lastRecordKey)) > 0
    )
      refuse('part_content')
    return JSON.stringify([part.collectionId, part.partIndex])
  }
  if (typeId !== ASSET_INDEX || !validateRuntime('DataRef', item).ok) refuse('asset_schema')
  if ((item as DataRef).kind === 'inline') checkInline(item as Extract<DataRef, { kind: 'inline' }>)
  // Includes authority, pin and schema; two references to the same bytes need not have the same rights.
  return canonicalJsonDigest(json(item))
}

export function compareIndexKeys(typeId: IndexType, left: string, right: string): number {
  if (typeId === ASSET_INDEX) return Buffer.compare(Buffer.from(left), Buffer.from(right))
  const a = parsePartKey(left),
    b = parsePartKey(right)
  return Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])) || a[1] - b[1]
}
function parsePartKey(key: string): [string, number] {
  let value: unknown
  try {
    value = JSON.parse(key)
  } catch {
    return refuse('key_schema')
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !validateRuntime('Id', value[0]).ok ||
    !validateRuntime('UInt53', value[1]).ok ||
    JSON.stringify(value) !== key
  )
    refuse('key_schema')
  return value as [string, number]
}
function checkInline(ref: Extract<DataRef, { kind: 'inline' }>): void {
  const bytes = encoded(ref.value)
  if (bytes.length !== ref.bytes || canonicalJsonDigest(ref.value) !== ref.digest) refuse('bad_digest')
}
async function readData(ref: DataRef, storage: IndexStorage, maximum: number): Promise<Buffer> {
  if (!validateRuntime('DataRef', ref).ok) refuse('ref_schema')
  if (ref.kind === 'inline') {
    if (ref.bytes > maximum) refuse('item_too_large')
    checkInline(ref)
    return encoded(ref.value)
  }
  if (ref.blob.bytes > maximum) refuse('item_too_large')
  const hash = createHash('sha256')
  const body = Buffer.allocUnsafe(ref.blob.bytes)
  let size = 0
  for await (const chunk of storage.read(ref.blob)) {
    if (size + chunk.byteLength > ref.blob.bytes) refuse('item_too_large')
    body.set(chunk, size)
    size += chunk.byteLength
    hash.update(chunk)
  }
  if (size !== ref.blob.bytes || hash.digest('hex') !== ref.blob.digest) refuse('bad_digest')
  return body
}

async function storeChecked(storage: IndexStorage, bytes: Buffer, typeId: string): Promise<DataRef> {
  const ref = await storage.put(bytes, typeId)
  if (ref.kind === 'inline' && ref.bytes > 65536) refuse('item_requires_blob')
  if (
    !validateRuntime('DataRef', ref).ok ||
    ref.schema.typeId !== typeId ||
    ref.schema.revision !== 1 ||
    indexDigest(ref) !== createHash('sha256').update(bytes).digest('hex') ||
    (ref.kind === 'inline' ? ref.bytes : ref.blob.bytes) !== bytes.length
  )
    refuse('storage_ref')
  return ref
}

/** Input is an owner-sorted stream. Unsorted/duplicate parts are refused, never buffered for a global sort. */
export async function buildExportIndex(
  typeId: IndexType,
  items: AsyncIterable<IndexItem>,
  storage: IndexStorage,
): Promise<DataRef> {
  if (typeId !== EXPORT_INDEX && typeId !== ASSET_INDEX) refuse('index_schema')
  const pending: (Entry[] | Branch[])[] = [[]]
  const sizes: number[] = [encoded({ typeId, level: 0, entries: [] }).length]
  let previous: string | null = null
  async function flush(level: number): Promise<Branch> {
    const entries = pending[level]!
    const bytes = encoded({ typeId, level, entries })
    if (bytes.length > INDEX_MAX_BYTES || entries.length > INDEX_MAX_ITEMS) refuse('page_limit')
    const child = await storeChecked(storage, bytes, typeId)
    pending[level] = []
    sizes[level] = encoded({ typeId, level, entries: [] }).length
    const first = entries[0],
      last = entries.at(-1)
    return {
      firstKey: first ? ('key' in first ? first.key : first.firstKey) : '',
      lastKey: last ? ('key' in last ? last.key : last.lastKey) : '',
      count:
        level === 0 ? entries.length : (entries as Branch[]).reduce((sum, entry) => sum + entry.count, 0),
      child,
    }
  }
  async function append(level: number, entry: Entry | Branch, knownSize?: number): Promise<void> {
    if (level >= MAX_DEPTH) refuse('tree_depth')
    pending[level] ??= []
    sizes[level] ??= encoded({ typeId, level, entries: [] }).length
    const size = knownSize ?? encoded(entry).length
    if (
      pending[level]!.length &&
      (pending[level]!.length === INDEX_MAX_ITEMS || sizes[level]! + size + 1 > PAGE_TARGET_BYTES)
    ) {
      await append(level + 1, await flush(level))
    }
    sizes[level]! += size + (pending[level]!.length ? 1 : 0)
    ;(pending[level] as (Entry | Branch)[]).push(entry)
    if (sizes[level]! > INDEX_MAX_BYTES) refuse('page_limit')
  }
  for await (const item of items) {
    const key = indexItemKey(typeId, item)
    if (previous !== null && compareIndexKeys(typeId, previous, key) >= 0) refuse('duplicate_or_unsorted')
    previous = key
    let entry: Entry = { key, item }
    let entrySize = encoded(entry).length
    if (entrySize + encoded({ typeId, level: 0, entries: [] }).length > INDEX_MAX_BYTES / 2) {
      if (encoded(item).length > MAX_ITEM_BYTES) refuse('item_too_large')
      const itemRef = await storeChecked(storage, encoded(item), `${typeId.replace('@1', '')}-item@1`)
      entry = { key, itemRef }
      entrySize = encoded(entry).length
    }
    await append(0, entry, entrySize)
  }
  for (let level = 0; level < pending.length; level++) {
    if (!pending[level]!.length && pending.length > 1) continue
    const branch = await flush(level)
    if (level === pending.length - 1) return branch.child
    await append(level + 1, branch)
  }
  return refuse('tree_empty')
}

function exactKeys(value: object, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === keys.sort().join(',')
}
/** Walks every page and verifies child ranges/counts. A missing page never means an empty collection. */
export async function* walkExportIndex(
  root: DataRef,
  typeId: IndexType,
  storage: IndexStorage,
  after: string | null = null,
): AsyncGenerator<IndexRow, number> {
  if (typeId !== EXPORT_INDEX && typeId !== ASSET_INDEX) refuse('index_schema')
  let previous: string | null = null,
    position = 0
  async function* visit(ref: DataRef, expectedLevel: number | null, depth: number): AsyncGenerator<IndexRow> {
    if (depth >= MAX_DEPTH || ref.schema.typeId !== typeId || ref.schema.revision !== 1)
      refuse('index_schema')
    let raw: unknown
    try {
      raw = JSON.parse((await readData(ref, storage, INDEX_MAX_BYTES)).toString('utf8'))
    } catch (error) {
      if (error instanceof ExportIndexError) throw error
      return refuse('page_unreadable')
    }
    if (!raw || typeof raw !== 'object' || !exactKeys(raw, ['typeId', 'level', 'entries']))
      refuse('index_schema')
    const node = raw as IndexNode
    if (
      node.typeId !== typeId ||
      !Number.isSafeInteger(node.level) ||
      node.level < 0 ||
      node.level >= MAX_DEPTH ||
      (expectedLevel !== null && node.level !== expectedLevel) ||
      !Array.isArray(node.entries) ||
      node.entries.length > INDEX_MAX_ITEMS ||
      (node.level > 0 && !node.entries.length)
    )
      refuse('index_schema')
    for (const entry of node.entries) {
      if (!entry || typeof entry !== 'object') refuse('index_schema')
      if (node.level === 0) {
        const leaf = entry as Entry
        if (
          typeof leaf.key !== 'string' ||
          !(exactKeys(leaf, ['key', 'item']) || exactKeys(leaf, ['key', 'itemRef']))
        )
          refuse('index_schema')
        let item = leaf.item
        if (leaf.itemRef) {
          if (
            leaf.itemRef.schema.typeId !== `${typeId.replace('@1', '')}-item@1` ||
            leaf.itemRef.schema.revision !== 1
          )
            refuse('item_schema')
          item = JSON.parse(
            (await readData(leaf.itemRef, storage, MAX_ITEM_BYTES)).toString('utf8'),
          ) as IndexItem
        }
        if (!item || indexItemKey(typeId, item) !== leaf.key) refuse('key_mismatch')
        if (previous !== null && compareIndexKeys(typeId, previous, leaf.key) >= 0)
          refuse('duplicate_or_unsorted')
        const preceding = previous
        previous = leaf.key
        position++
        if (after !== null && compareIndexKeys(typeId, leaf.key, after) <= 0) continue
        if (
          after !== null &&
          preceding !== after &&
          compareIndexKeys(typeId, after, preceding ?? leaf.key) >= 0
        )
          refuse('checkpoint_invalid')
        const row: IndexRow = { key: leaf.key, item: item!, position }
        if (leaf.itemRef) row.descriptor = leaf.itemRef
        yield row
      } else {
        const branch = entry as Branch
        if (
          !exactKeys(branch, ['firstKey', 'lastKey', 'count', 'child']) ||
          typeof branch.firstKey !== 'string' ||
          typeof branch.lastKey !== 'string' ||
          !Number.isSafeInteger(branch.count) ||
          branch.count <= 0 ||
          !validateRuntime('DataRef', branch.child).ok
        )
          refuse('index_schema')
        if (
          compareIndexKeys(typeId, branch.firstKey, branch.lastKey) > 0 ||
          (previous !== null && compareIndexKeys(typeId, previous, branch.firstKey) >= 0)
        )
          refuse('child_summary')
        // Pagination may seek over Merkle summaries; full verification never skips a child.
        if (after !== null && compareIndexKeys(typeId, branch.lastKey, after) <= 0) {
          previous = branch.lastKey
          position += branch.count
          if (!Number.isSafeInteger(position)) refuse('child_summary')
          continue
        }
        let count = 0,
          first: string | null = null,
          last: string | null = null
        for await (const row of visit(branch.child, node.level - 1, depth + 1)) {
          first ??= row.key
          last = row.key
          count++
          yield row
        }
        if (
          (after === null || compareIndexKeys(typeId, after, branch.firstKey) < 0) &&
          (count !== branch.count || first !== branch.firstKey || last !== branch.lastKey)
        )
          refuse('child_summary')
      }
    }
  }
  yield* visit(root, null, 0)
  if (after !== null && (previous === null || compareIndexKeys(typeId, previous, after) < 0))
    refuse('checkpoint_invalid')
  return position
}

export function initialIndexCheckpoint(
  root: DataRef,
  typeId: IndexType,
  fenceDigest: string,
): IndexCheckpoint {
  if (!validateRuntime('Digest', fenceDigest).ok) refuse('fence_digest')
  return { version: 1, typeId, manifestDigest: indexDigest(root), fenceDigest, after: null, consumed: 0 }
}
export function encodeIndexCursor(checkpoint: IndexCheckpoint): string {
  return Buffer.from(jcs(json(checkpoint))).toString('base64url')
}
export function decodeIndexCursor(cursor: string, expected: IndexCheckpoint): IndexCheckpoint {
  if (cursor.length > 16384) refuse('cursor_invalid')
  let parsed: IndexCheckpoint
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as IndexCheckpoint
  } catch {
    return refuse('cursor_invalid')
  }
  if (
    !parsed ||
    !exactKeys(parsed, ['version', 'typeId', 'manifestDigest', 'fenceDigest', 'after', 'consumed']) ||
    parsed.version !== 1 ||
    parsed.typeId !== expected.typeId ||
    parsed.manifestDigest !== expected.manifestDigest ||
    parsed.fenceDigest !== expected.fenceDigest ||
    !Number.isSafeInteger(parsed.consumed) ||
    parsed.consumed < 0 ||
    (parsed.after !== null && typeof parsed.after !== 'string') ||
    (parsed.consumed === 0) !== (parsed.after === null) ||
    encodeIndexCursor(parsed) !== cursor
  )
    refuse('cursor_invalid')
  return parsed
}
/** Recovery revalidates the immutable prefix; already accepted items are never delivered again. Persist
 * checkpoints only after the owner transaction/inbox accepts an item. This is not an import receipt. */
export async function verifyExportIndex(
  root: DataRef,
  checkpoint: IndexCheckpoint,
  storage: IndexStorage,
  accept: (item: IndexItem, next: IndexCheckpoint) => Promise<void>,
): Promise<IndexCheckpoint> {
  const start = initialIndexCheckpoint(root, checkpoint.typeId, checkpoint.fenceDigest)
  decodeIndexCursor(encodeIndexCursor(checkpoint), start)
  let next = start,
    matched = checkpoint.consumed === 0 && checkpoint.after === null
  for await (const row of walkExportIndex(root, checkpoint.typeId, storage)) {
    next = { ...next, after: row.key, consumed: next.consumed + 1 }
    if (next.consumed <= checkpoint.consumed) {
      if (next.consumed === checkpoint.consumed) matched = next.after === checkpoint.after
      continue
    }
    if (!matched) refuse('checkpoint_invalid')
    await accept(row.item, next)
  }
  if (!matched || next.consumed < checkpoint.consumed) refuse('checkpoint_invalid')
  return next
}

async function pageItem(
  typeId: IndexType,
  item: IndexItem,
  storage: IndexStorage,
  descriptor?: DataRef,
): Promise<IndexItem> {
  if (descriptor) return descriptor
  // A descriptor near the codec limit cannot fit with page/cursor framing. Return a pinned
  // reference to that descriptor, not a claim that the referenced asset bytes were copied.
  if (encoded(item).length > INDEX_MAX_BYTES / 2)
    return storeChecked(storage, encoded(item), `${typeId.replace('@1', '')}-item@1`)
  return item
}

export async function exportIndexPage(
  root: DataRef,
  typeId: IndexType,
  fenceDigest: string,
  cursor: string | null,
  limit: number,
  storage: IndexStorage,
): Promise<{ items: IndexItem[]; nextCursor: string | null; complete: boolean }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > INDEX_MAX_ITEMS) refuse('page_limit')
  const start = initialIndexCheckpoint(root, typeId, fenceDigest)
  const checkpoint = cursor === null ? start : decodeIndexCursor(cursor, start)
  const items: IndexItem[] = []
  let next = checkpoint
  const walker = walkExportIndex(root, typeId, storage, checkpoint.after)
  try {
    for (;;) {
      const result = await walker.next()
      if (result.done) {
        if (result.value !== next.consumed) refuse('checkpoint_invalid')
        return { items, nextCursor: null, complete: true }
      }
      const row = result.value
      if (row.position !== next.consumed + 1) refuse('checkpoint_invalid')
      const rowCheckpoint = { ...next, after: row.key, consumed: row.position }
      const output = await pageItem(typeId, row.item, storage, row.descriptor)
      const prospective = {
        items: [...items, output],
        nextCursor: encodeIndexCursor(rowCheckpoint),
        complete: false,
      }
      if (items.length === limit || encoded(prospective).length > INDEX_MAX_BYTES) {
        if (!items.length) refuse('item_requires_blob')
        return { items, nextCursor: encodeIndexCursor(next), complete: false }
      }
      items.push(output)
      next = rowCheckpoint
    }
  } finally {
    await walker.return(0)
  }
}
