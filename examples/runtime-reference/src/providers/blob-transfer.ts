import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { AuthorityTransferControl, CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  type RuntimeErrorDetails,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  type RuntimeWireTypes,
  validateRuntime,
} from '@agnes/protocol/runtime'

type Detail = keyof typeof RuntimeErrorDetails

/** What the maintenance assembly tells one reference store about its place in the directory. */
export type TransferMaintenance = Readonly<{
  /** Whether the caller is the maintenance controller. */
  authorize(context: CallContext): boolean
  tenantId: Wire.Id
  /** The directory location this store serves or imports at. */
  locationRef: Wire.Id
  /**
   * The route the directory durably holds for the authority, and whether a target of the upgrade has
   * been activated.
   */
  readRoute(
    request: Readonly<{ logicalAuthorityId: Wire.Id; upgradeId: Wire.Id }>,
    context: CallContext,
  ): Promise<Outcome<Readonly<{ route: Wire.AuthorityRoute; targetActivated: boolean }>>>
  /** The bytes the source of an import exported under `ref`: its index pages and part chunks. */
  readSource(ref: Wire.BlobRef, context: CallContext): AsyncIterable<Uint8Array>
  /** The fingerprint of the migration plan this store's validations are issued for. */
  planFingerprint: Wire.Digest
}>

/** What a reference store lends its transfer side. Its `authority` table holds its role and epoch. */
export type TransferHost = Readonly<{
  db: DatabaseSync
  authorityId: Wire.Id
  /** Names the store's collections and schemas: `reference.<name>/<table>`. */
  name: string
  /**
   * The business tables a checkpoint covers, each with the SQL that gives a record its key. Rows are
   * read in key order, so a part's keys are its first and last.
   */
  tables: Readonly<Record<string, string>>
  /** The table whose `seq` head is the store's deletion or revocation watermark. */
  log: string
  /**
   * The blobs the records name, which the selected blob service's own transfer moves, and whether that
   * service holds one intact. Without it the store needs no assets.
   */
  assets?: Readonly<{ list(): Iterable<Wire.BlobRef>; present(ref: Wire.BlobRef): boolean }>
  maintenance: TransferMaintenance | undefined
  /** The most records and encoded bytes one exported part holds. */
  part: Readonly<{ records: number; bytes: number }>
  live(): void
  /** One transaction outside the business write gate. */
  transaction<T>(body: () => T): T
  refuse(detail: Detail, message: string): never
  attempt<T>(context: CallContext, body: () => T | Promise<T>): Promise<Outcome<T>>
}>

const EXPORT_INDEX = 'agh.migration/export-index@1'
const ASSET_INDEX = 'agh.migration/asset-index@1'
const PAGE_ITEMS = 500
const PAGE_BYTES = 1024 * 1024
/** The largest chunk an import holds in memory; parts are cut far below it. */
const CHUNK_BYTES = 64 * 1024 * 1024
const SLICE_BYTES = 1024 * 1024

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const fingerprint = (value: unknown) => sha256(jcs(value))
const schemaRef = (typeId: string): Wire.SchemaRef => ({
  typeId,
  revision: 1,
  digest: canonicalJsonDigest({ typeId }),
})
const inline = (typeId: string, value: Wire.JsonValue): Wire.DataRef => ({
  kind: 'inline',
  schema: schemaRef(typeId),
  value,
  digest: canonicalJsonDigest(value),
  bytes: Buffer.byteLength(jcs(value)),
})

type Collection = { table: string; key: string; id: Wire.Id; schema: Wire.SchemaRef }
type Row = Record<string, unknown>
type Part = Wire.AuthorityExportPart
type ImportResult = Wire.AuthorityTransferControlImportResult
type Branch = { firstKey: string; lastKey: string; count: number; child: Wire.DataRef }
type TransferRow = Record<
  'fence_input' | 'fence' | 'export' | 'import_input' | 'source' | 'imported' | 'outcome_input' | 'outcome',
  string | null
> & { watermark: number | null }

/**
 * The maintenance namespace, never part of a checkpoint: one row per upgrade (a store is its source or
 * its target), the parts an import has committed, and the bytes an export wrote, by digest.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS transfers (
  upgrade_id TEXT PRIMARY KEY,
  fence_input TEXT, fence TEXT, watermark INTEGER, export TEXT,
  import_input TEXT, source TEXT, imported TEXT,
  outcome_input TEXT, outcome TEXT
);
CREATE TABLE IF NOT EXISTS transfer_parts (
  upgrade_id TEXT NOT NULL,
  part TEXT NOT NULL,
  PRIMARY KEY (upgrade_id, part)
);
CREATE TABLE IF NOT EXISTS transfer_bytes (digest TEXT PRIMARY KEY, data BLOB NOT NULL);`

const order = (left: Part, right: Part) =>
  Buffer.compare(Buffer.from(left.collectionId), Buffer.from(right.collectionId)) ||
  left.partIndex - right.partIndex

/** A row as one chunk line: byte cells travel as base64. */
const encode = (row: Row) =>
  Object.fromEntries(
    Object.entries(row).map(([name, cell]) => [
      name,
      cell instanceof Uint8Array ? { base64: Buffer.from(cell).toString('base64') } : cell,
    ]),
  )

/**
 * The transfer side of one reference store. A source fences, exports and aborts; a candidate store
 * imports, verifies and activates. Every call is idempotent by upgrade id and request fingerprint, and
 * probe reads only what is committed.
 */
export function openTransfer(host: TransferHost) {
  const { db, authorityId, maintenance, assets } = host
  db.exec(DDL)
  // Collection order is the UTF-8 bytes of the id. Cross-implementation collection schemas are not
  // defined yet, so these ids are the reference's own.
  const COLLECTIONS: Collection[] = Object.entries(host.tables)
    .map(([table, key]) => ({
      table,
      key,
      id: `reference.${host.name}/${table}`,
      schema: schemaRef(`agh.reference.${host.name}/${table}-rows@1`),
    }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)))
  const CONTENT = schemaRef(`agh.reference.${host.name}/content@1`)
  function refuse(detail: Detail, message: string): never {
    return host.refuse(detail, message)
  }
  const parse = <K extends keyof RuntimeWireTypes>(
    name: K,
    value: unknown,
    detail: Detail = 'invalid_request',
  ): RuntimeWireTypes[K] => {
    const result = validateRuntime(name, value)
    return result.ok ? result.value : refuse(detail, `${name} does not match its schema`)
  }
  const checked = <K extends keyof RuntimeWireTypes>(name: K, value: unknown) =>
    parse(name, value, 'internal_error')
  const role = () => db.prepare('SELECT role, epoch FROM authority WHERE id = 1').get() as Row
  const transfer = (upgradeId: Wire.Id) =>
    db.prepare('SELECT * FROM transfers WHERE upgrade_id = ?').get(upgradeId) as TransferRow | undefined
  const head = () =>
    (db.prepare(`SELECT COALESCE(MAX(seq), 0) AS head FROM ${host.log}`).get() as { head: number }).head
  const columns = new Map(
    COLLECTIONS.map(({ table }) => [
      table,
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name),
    ]),
  )

  /** The caller must be the maintenance controller of a store that has a maintenance assembly. */
  function admit(context: CallContext): TransferMaintenance {
    if (!maintenance) refuse('operation_not_supported', 'authority transfer is not configured')
    host.live()
    if (!maintenance.authorize(context))
      refuse('permission_denied', 'caller is not the maintenance controller')
    return maintenance
  }

  const records = (collection: Collection) =>
    db
      .prepare(`SELECT *, ${collection.key} AS record_key FROM ${collection.table} ORDER BY record_key`)
      .iterate() as Iterable<Row & { record_key: string }>

  /** Digest and count of every business record in collection and key order; byte cells enter by digest. */
  function snapshot() {
    const hash = createHash('sha256')
    let recordCount = 0
    for (const collection of COLLECTIONS)
      for (const { record_key: key, ...row } of records(collection)) {
        const cells = Object.entries(row).map(([name, cell]) => [
          name,
          cell instanceof Uint8Array ? { sha256: sha256(cell) } : cell,
        ])
        hash.update(`${jcs([collection.id, key, Object.fromEntries(cells)])}\n`)
        recordCount += 1
      }
    return { snapshotDigest: hash.digest('hex'), recordCount }
  }

  /** Stores exported bytes under their digest and names them as a blob of this authority. */
  function put(bytes: Uint8Array, mediaType: string): Wire.BlobRef {
    const digest = sha256(bytes)
    db.prepare('INSERT OR IGNORE INTO transfer_bytes (digest, data) VALUES (?, ?)').run(digest, bytes)
    return {
      authorityId,
      blobId: digest,
      digest,
      bytes: bytes.byteLength,
      mediaType,
      pinId: 'authority-export',
    }
  }

  function stored(ref: Wire.BlobRef): Uint8Array {
    const row = db.prepare('SELECT data FROM transfer_bytes WHERE digest = ?').get(ref.blobId) as
      | { data: Uint8Array }
      | undefined
    if (ref.authorityId !== authorityId || !row) refuse('not_found', 'no such exported bytes')
    return row.data
  }

  /**
   * Writes a bounded Merkle page tree bottom up. Leaf pages hold items, upper pages hold `{firstKey,
   * lastKey, count, child}`; a page holds at most 500 entries and 1 MiB encoded, and each page's
   * digest covers its children's. Only the open page of each level is in memory.
   */
  function indexWriter(typeId: string) {
    type Open = { entries: unknown[]; bytes: number; firstKey: string; lastKey: string; count: number }
    const levels: Open[] = []
    const fresh = (): Open => ({ entries: [], bytes: 0, firstKey: '', lastKey: '', count: 0 })
    const write = (level: number, entries: unknown[]): Wire.DataRef => ({
      kind: 'blob',
      schema: schemaRef(typeId),
      blob: put(Buffer.from(jcs({ typeId, level, entries })), 'application/json'),
    })
    function add(level: number, entry: unknown, firstKey: string, lastKey: string, count: number) {
      const bytes = Buffer.byteLength(jcs(entry)) + 1
      let open = levels[level] ?? fresh()
      levels[level] = open
      // The margin leaves room for the page's own fields around its entries.
      if (open.entries.length === PAGE_ITEMS || open.bytes + bytes > PAGE_BYTES - 1024) {
        close(level)
        open = levels[level] as Open
      }
      if (open.entries.length === 0) open.firstKey = firstKey
      open.entries.push(entry)
      open.bytes += bytes
      open.lastKey = lastKey
      open.count += count
    }
    function close(level: number) {
      const { entries, firstKey, lastKey, count } = levels[level] as Open
      levels[level] = fresh()
      add(level + 1, { firstKey, lastKey, count, child: write(level, entries) }, firstKey, lastKey, count)
    }
    return {
      add: (key: string, item: unknown) => add(0, item, key, key, 1),
      /** Closes every level below the top and writes the top page as the root, an empty leaf if unused. */
      finish(): Wire.DataRef {
        for (let level = 0; ; level += 1) {
          const open = levels[level] ?? fresh()
          if (level + 1 >= levels.length) return write(level, open.entries)
          if (open.entries.length > 0) close(level)
        }
      },
    }
  }

  /**
   * The items of the tree under `ref` from position `from` on. One page is loaded at a time, and each
   * page's type, bounds and level, and every count its parent recorded, are checked on the way.
   */
  async function* items(
    ref: Wire.DataRef,
    typeId: string,
    from: number,
    load: (blob: Wire.BlobRef) => Promise<Uint8Array>,
    level: number | null = null,
  ): AsyncGenerator<unknown> {
    if (ref.kind !== 'blob' || ref.schema.typeId !== typeId)
      refuse('integrity', 'index page reference is malformed')
    let page: { typeId?: unknown; level?: unknown; entries?: unknown }
    try {
      page = JSON.parse(Buffer.from(await load(ref.blob)).toString('utf8'))
    } catch (caught) {
      if (caught instanceof SyntaxError) refuse('integrity', 'index page is not JSON')
      throw caught
    }
    const { entries } = page
    if (
      page.typeId !== typeId ||
      !Array.isArray(entries) ||
      entries.length > PAGE_ITEMS ||
      typeof page.level !== 'number' ||
      !Number.isSafeInteger(page.level) ||
      page.level < 0 ||
      (level !== null && page.level !== level)
    )
      refuse('integrity', 'index page is malformed')
    if (page.level === 0) {
      yield* entries.slice(from)
      return
    }
    let skip = from
    for (const branch of entries as Branch[]) {
      if (!Number.isSafeInteger(branch?.count) || branch.count < 1 || typeof branch.child !== 'object')
        refuse('integrity', 'index branch is malformed')
      if (skip >= branch.count) {
        skip -= branch.count
        continue
      }
      let seen = 0
      for await (const item of items(branch.child, typeId, skip, load, page.level - 1)) {
        seen += 1
        yield item
      }
      if (seen !== branch.count - skip) refuse('integrity', 'index count differs from its pages')
      skip = 0
    }
  }

  /** Reads one exported blob from the source in full, refused unless its size and digest match. */
  async function download(
    source: TransferMaintenance,
    ref: Wire.BlobRef,
    context: CallContext,
    limit: number,
  ) {
    if (ref.bytes > limit) refuse('integrity', 'exported bytes exceed what an import reads at once')
    const pieces: Uint8Array[] = []
    let size = 0
    for await (const piece of source.readSource(ref, context)) {
      size += piece.byteLength
      if (size > ref.bytes) refuse('integrity', 'exported bytes run past their size')
      pieces.push(piece)
    }
    const bytes = Buffer.concat(pieces)
    if (size !== ref.bytes || sha256(bytes) !== ref.digest)
      refuse('integrity', 'exported bytes do not match their digest')
    return bytes
  }

  /** One chunk line as a row of `table`: exactly the table's columns, byte cells decoded. */
  function decode(table: string, line: string): SQLInputValue[] {
    let row: Row
    try {
      row = JSON.parse(line) as Row
    } catch {
      refuse('integrity', 'exported record is not JSON')
    }
    const names = columns.get(table) ?? []
    if (Object.keys(row).length !== names.length)
      refuse('integrity', 'exported record does not match its table')
    return names.map((name) => {
      const cell = row[name]
      if (cell === null || typeof cell === 'string' || typeof cell === 'number') return cell
      const base64 = (cell as { base64?: unknown } | undefined)?.base64
      if (typeof base64 !== 'string') refuse('integrity', 'exported record does not match its table')
      return Buffer.from(base64, 'base64')
    })
  }

  function fenced(upgradeId: Wire.Id, fenceId: Wire.Id) {
    const row = transfer(upgradeId)
    if (!row?.fence) refuse('not_found', 'no fence was taken for this upgrade')
    const fence = JSON.parse(row.fence) as Wire.AuthorityFence
    if (fence.fenceId !== fenceId) refuse('revision_conflict', 'fence id does not match')
    return { fence, row }
  }

  const routeOf = (ref: Wire.DataRef) =>
    ref.kind === 'inline'
      ? parse('AuthorityRoute', ref.value)
      : refuse('invalid_request', 'route must be inline')

  /** The route must be exactly the one the directory durably holds; reports whether a target was activated. */
  async function published(
    source: TransferMaintenance,
    route: Wire.AuthorityRoute,
    upgradeId: Wire.Id,
    context: CallContext,
  ) {
    const held = await source.readRoute({ logicalAuthorityId: route.logicalAuthorityId, upgradeId }, context)
    if (!held.ok || jcs(held.value.route) !== jcs(route))
      refuse('revision_conflict', 'route is not the published route')
    return held.value.targetActivated
  }

  const cursorOf = (fenceId: Wire.Id, manifestDigest: Wire.Digest, at: number) =>
    Buffer.from(jcs({ fenceId, manifestDigest, at })).toString('base64url')

  function position(cursor: string, fenceId: Wire.Id, manifestDigest: Wire.Digest, end: number): number {
    let at: unknown
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Row
      if (decoded.fenceId === fenceId && decoded.manifestDigest === manifestDigest) at = decoded.at
    } catch {
      at = undefined
    }
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || at > end)
      refuse('invalid_request', 'cursor does not belong to this export')
    return at
  }

  /** Cuts every collection into parts, writing chunks and the manifest tree, and records the export. */
  function exportAll(upgradeId: Wire.Id, fence: Wire.AuthorityFence, watermark: number) {
    const manifest = indexWriter(EXPORT_INDEX)
    const collections = new Set<string>()
    let partCount = 0
    for (const collection of COLLECTIONS) {
      let lines: string[] = []
      let bytes = 0
      let first = ''
      let last = ''
      let partIndex = 0
      const cut = () => {
        if (lines.length === 0) return
        const chunk = put(Buffer.from(lines.join('')), 'application/x-ndjson')
        manifest.add(jcs([collection.id, partIndex]), {
          collectionId: collection.id,
          schema: collection.schema,
          partIndex,
          firstRecordKey: first,
          lastRecordKey: last,
          records: lines.length,
          contentDigest: chunk.digest,
          chunk,
        } satisfies Part)
        collections.add(collection.id)
        partCount += 1
        partIndex += 1
        lines = []
        bytes = 0
      }
      for (const { record_key: key, ...row } of records(collection)) {
        const line = `${jcs(encode(row))}\n`
        const size = Buffer.byteLength(line)
        if (lines.length === host.part.records || (lines.length > 0 && bytes + size > host.part.bytes)) cut()
        if (lines.length === 0) first = key
        lines.push(line)
        bytes += size
        last = key
      }
      cut()
    }
    return checked('AuthorityExport', {
      upgradeId,
      fenceId: fence.fenceId,
      checkpoint: fence.checkpoint,
      collectionCount: collections.size,
      partCount,
      manifestRoot: manifest.finish(),
      requiredAssetsRoot: assetIndex(),
      deletionWatermark: watermark,
    })
  }

  /**
   * The blobs the records name, each once in key order. A blob store's content travels in its own
   * parts, so its index is empty.
   */
  function assetIndex(): Wire.DataRef {
    const index = indexWriter(ASSET_INDEX)
    // ponytail: sorts every asset ref in memory; stage them in a table once stores name many blobs.
    const refs = new Map([...(assets?.list() ?? [])].map((ref) => [jcs(ref), ref]))
    for (const key of [...refs.keys()].sort())
      index.add(key, { kind: 'blob', schema: CONTENT, blob: refs.get(key) })
    return index.finish()
  }

  /** How many blobs the records name that the selected blob service does not hold intact. */
  const absent = () => (assets ? [...assets.list()].filter((ref) => !assets.present(ref)).length : 0)

  const control: AuthorityTransferControl = {
    /** Installs the write gate and takes the checkpoint and deletion watermark in one transaction. */
    fence: (request, context) =>
      host.attempt(context, () => {
        const source = admit(context)
        const input = parse('AuthorityTransferControlFenceRequest', request)
        const print = fingerprint(input)
        return host.transaction(() => {
          const prior = transfer(input.upgradeId)
          if (prior?.fence) {
            if (prior.fence_input !== print)
              refuse('idempotency_conflict', 'upgrade already fenced other input')
            return JSON.parse(prior.fence) as Wire.AuthorityFence
          }
          if (prior) refuse('revision_conflict', 'this store is the target of the upgrade')
          const current = role()
          const { expected } = input
          if (
            current.role !== 'serving' ||
            expected.authorityId !== authorityId ||
            expected.tenantId !== source.tenantId ||
            expected.authorityEpoch !== current.epoch
          )
            refuse('revision_conflict', 'store does not serve the expected authority')
          const fence = checked('AuthorityFence', {
            upgradeId: input.upgradeId,
            source: expected,
            fenceId: randomUUID(),
            fenceEpoch: current.epoch,
            checkpoint: {
              authorityId,
              authorityEpoch: current.epoch,
              checkpointId: randomUUID(),
              ...snapshot(),
              bridgeWatermarks: [],
            },
            writerCredentialsRevoked: true,
          })
          db.prepare("UPDATE authority SET role = 'fenced' WHERE id = 1").run()
          db.prepare(
            'INSERT INTO transfers (upgrade_id, fence_input, fence, watermark) VALUES (?, ?, ?, ?)',
          ).run(input.upgradeId, print, jcs(fence), head())
          return fence
        })
      }),

    /** Exports the fenced checkpoint once; a repeat returns the same export. */
    export: (request, context) =>
      host.attempt(context, () => {
        admit(context)
        const input = parse('AuthorityTransferControlExportRequest', request)
        return host.transaction(() => {
          const { fence, row } = fenced(input.upgradeId, input.fenceId)
          if (row.export) return JSON.parse(row.export) as Wire.AuthorityExport
          if (row.outcome) refuse('revision_conflict', 'the transfer was aborted')
          const now = snapshot()
          if (
            now.snapshotDigest !== fence.checkpoint.snapshotDigest ||
            now.recordCount !== fence.checkpoint.recordCount
          )
            refuse('integrity', 'records changed since the fence')
          const exported = exportAll(input.upgradeId, fence, row.watermark ?? 0)
          db.prepare('UPDATE transfers SET export = ? WHERE upgrade_id = ?').run(
            jcs(exported),
            input.upgradeId,
          )
          return exported
        })
      }),

    /** Pages through the manifest in part order; the cursor is bound to the fence and manifest digest. */
    exportPage: (request, context) =>
      host.attempt(context, async () => {
        admit(context)
        const input = parse('AuthorityTransferControlExportPageRequest', request)
        const { fence, row } = fenced(input.upgradeId, input.fenceId)
        if (!row.export) refuse('not_found', 'nothing was exported for this upgrade')
        const exported = JSON.parse(row.export) as Wire.AuthorityExport
        const root = exported.manifestRoot
        if (root.kind !== 'blob' || root.blob.digest !== input.manifestDigest)
          refuse('revision_conflict', 'manifest digest does not match the export')
        if (input.limit < 1 || input.limit > PAGE_ITEMS)
          refuse('invalid_request', 'page limit must be 1 to 500')
        const from =
          input.cursor === null
            ? 0
            : position(input.cursor, input.fenceId, input.manifestDigest, exported.partCount)
        const page: unknown[] = []
        for await (const item of items(root, EXPORT_INDEX, from, async (blob) => stored(blob))) {
          page.push(item)
          if (page.length === input.limit) break
        }
        const at = from + page.length
        const nextCursor = at < exported.partCount ? cursorOf(input.fenceId, input.manifestDigest, at) : null
        return checked('AuthorityTransferControlExportPageResult', {
          items: page,
          snapshot: fence.checkpoint.checkpointId,
          nextCursor,
          complete: nextCursor === null,
        })
      }),

    /**
     * Copies an export into this candidate one part at a time: each chunk is read from the source,
     * checked against its digest and committed with its part key, so a retry skips what is already in
     * and memory holds at most one page and one chunk.
     */
    import: (request, context) =>
      host.attempt(context, async () => {
        const target = admit(context)
        const input = parse('AuthorityTransferControlImportRequest', request)
        const print = fingerprint(input)
        const { source, upgradeId } = input
        const done = host.transaction(() => {
          const prior = transfer(upgradeId)
          if (prior?.import_input && prior.import_input !== print)
            refuse('idempotency_conflict', 'upgrade already imported other input')
          if (prior?.imported) return JSON.parse(prior.imported) as ImportResult
          if (prior?.fence) refuse('revision_conflict', 'this store is the source of the upgrade')
          if (role().role !== 'candidate') refuse('revision_conflict', 'only a candidate store imports')
          if (
            input.targetLocationRef !== target.locationRef ||
            source.upgradeId !== upgradeId ||
            source.checkpoint.authorityId !== authorityId
          )
            refuse('revision_conflict', 'import names another location or authority')
          if (db.prepare('SELECT 1 FROM transfers WHERE upgrade_id <> ?').get(upgradeId))
            refuse('revision_conflict', 'candidate holds another upgrade')
          if (!prior)
            db.prepare('INSERT INTO transfers (upgrade_id, import_input, source) VALUES (?, ?, ?)').run(
              upgradeId,
              print,
              jcs(source),
            )
          return null
        })
        if (done) return done
        const load = (blob: Wire.BlobRef) => download(target, blob, context, PAGE_BYTES)
        const collections = new Set<string>()
        let count = 0
        let previous: Part | null = null
        for await (const item of items(source.manifestRoot, EXPORT_INDEX, 0, load)) {
          if (context.signal.aborted) refuse('cancelled', 'import was cancelled')
          const part = parse('AuthorityExportPart', item, 'integrity')
          if (previous && order(previous, part) >= 0) refuse('integrity', 'export parts are out of order')
          previous = part
          count += 1
          collections.add(part.collectionId)
          const collection =
            COLLECTIONS.find(
              (each) => each.id === part.collectionId && jcs(each.schema) === jcs(part.schema),
            ) ?? refuse('integrity', 'export part names an unknown collection')
          const key = jcs([part.collectionId, part.partIndex])
          if (
            db.prepare('SELECT 1 FROM transfer_parts WHERE upgrade_id = ? AND part = ?').get(upgradeId, key)
          )
            continue
          if (part.contentDigest !== part.chunk.digest)
            refuse('integrity', 'part digest differs from its chunk')
          const lines = (await download(target, part.chunk, context, CHUNK_BYTES))
            .toString('utf8')
            .split('\n')
          if (lines.pop() !== '' || lines.length !== part.records)
            refuse('integrity', 'part records differ from its count')
          const columnList = columns.get(collection.table) ?? []
          const insert = db.prepare(
            `INSERT INTO ${collection.table} (${columnList.join(', ')}) VALUES (${columnList.map(() => '?').join(', ')})`,
          )
          host.transaction(() => {
            for (const line of lines) insert.run(...decode(collection.table, line))
            db.prepare('INSERT INTO transfer_parts (upgrade_id, part) VALUES (?, ?)').run(upgradeId, key)
          })
        }
        if (count !== source.partCount || collections.size !== source.collectionCount)
          refuse('integrity', 'export parts differ from its counts')
        // The selected blob service moves the assets' bytes; verify and activate check they arrived.
        for await (const item of items(source.requiredAssetsRoot, ASSET_INDEX, 0, load)) {
          if (!assets) refuse('integrity', 'this store needs no assets')
          if (parse('DataRef', item, 'integrity').kind !== 'blob')
            refuse('integrity', 'an asset is not a blob')
        }
        return host.transaction(() => {
          const prior = transfer(upgradeId)
          if (prior?.imported) return JSON.parse(prior.imported) as ImportResult
          // Deleted content stays deleted: the copied log must end at the export's watermark.
          if (head() !== source.deletionWatermark)
            refuse('integrity', 'imported deletion log differs from the export watermark')
          const targetCheckpoint = {
            authorityId,
            authorityEpoch: source.checkpoint.authorityEpoch,
            checkpointId: randomUUID(),
            ...snapshot(),
            bridgeWatermarks: [],
          }
          const exportDigest = fingerprint(source)
          const candidate = { upgradeId, locationRef: target.locationRef, exportDigest, targetCheckpoint }
          const result = checked('AuthorityTransferControlImportResult', {
            targetCheckpoint,
            // Provisional: the shared candidate document is not defined for authority transfers yet.
            candidateRef: inline(`agh.reference.${host.name}/candidate@1`, candidate),
          })
          db.prepare('UPDATE transfers SET imported = ? WHERE upgrade_id = ?').run(jcs(result), upgradeId)
          return result
        })
      }),

    /** Read-only: recomputes the candidate and reports each check; a damaged candidate is not accepted. */
    verify: (request, context) =>
      host.attempt(context, () => {
        const target = admit(context)
        const input = parse('AuthorityTransferControlVerifyRequest', request)
        const row = transfer(input.upgradeId)
        if (!row?.imported) refuse('not_found', 'no candidate was imported for this upgrade')
        const { targetCheckpoint, candidateRef } = JSON.parse(row.imported) as ImportResult
        const { checkpoint } = input.source
        const now = snapshot()
        const check = (checkId: string, actual: unknown, expected: unknown) => ({
          checkId,
          passed: jcs(actual) === jcs(expected),
          evidence: inline(`agh.reference.${host.name}/check@1`, { actual, expected } as Wire.JsonValue),
        })
        const checks = [
          check('source-export', fingerprint(input.source), fingerprint(JSON.parse(row.source as string))),
          check('candidate-ref', input.candidateRef, candidateRef),
          check('candidate-records', now, {
            snapshotDigest: targetCheckpoint.snapshotDigest,
            recordCount: targetCheckpoint.recordCount,
          }),
          check('source-records', now, {
            snapshotDigest: checkpoint.snapshotDigest,
            recordCount: checkpoint.recordCount,
          }),
          check('deletion-watermark', head(), input.source.deletionWatermark),
          check('required-assets', absent(), 0),
        ]
        return checked('MigrationValidation', {
          upgradeId: input.upgradeId,
          planFingerprint: target.planFingerprint,
          candidateDigest: candidateRef.kind === 'inline' ? candidateRef.digest : candidateRef.blob.digest,
          sourceSnapshotDigest: checkpoint.snapshotDigest,
          checkedAt: new Date().toISOString(),
          checks,
          validatorBindings: [],
          accepted: checks.every((item) => item.passed),
        })
      }),

    /**
     * Serves the candidate at the route's epoch, only when the directory durably holds exactly that route
     * for this location, at an epoch past the fence, and the route names the imported checkpoint
     * re-stamped at that epoch; the activated probe reports the route's checkpoint.
     */
    activate: (request, context) =>
      host.attempt(context, async () => {
        const target = admit(context)
        const input = parse('AuthorityTransferControlActivateRequest', request)
        const print = fingerprint(input)
        const settled = () => {
          const row = transfer(input.upgradeId)
          if (!row?.imported || !row.source) refuse('not_found', 'no candidate was imported for this upgrade')
          if (row.outcome && row.outcome_input !== print)
            refuse('idempotency_conflict', 'upgrade was activated by another request')
          return { row, imported: row.imported, source: row.source }
        }
        const first = settled()
        if (first.row.outcome) return JSON.parse(first.row.outcome) as Wire.AuthorityTransferProbe
        const { targetCheckpoint } = JSON.parse(first.imported) as ImportResult
        const fenceEpoch = (JSON.parse(first.source) as Wire.AuthorityExport).checkpoint.authorityEpoch
        const route = routeOf(input.publishedRoute)
        if (
          route.cutoverId !== input.cutoverId ||
          route.logicalAuthorityId !== authorityId ||
          route.tenantId !== target.tenantId ||
          route.locationRef !== target.locationRef ||
          route.authorityEpoch <= fenceEpoch ||
          jcs(route.checkpoint) !== jcs({ ...targetCheckpoint, authorityEpoch: route.authorityEpoch })
        )
          refuse('revision_conflict', 'route does not activate this candidate')
        await published(target, route, input.upgradeId, context)
        return host.transaction(() => {
          const again = settled()
          if (again.row.outcome) return JSON.parse(again.row.outcome) as Wire.AuthorityTransferProbe
          if (role().role !== 'candidate') refuse('revision_conflict', 'store is no longer a candidate')
          const now = snapshot()
          if (
            now.snapshotDigest !== targetCheckpoint.snapshotDigest ||
            now.recordCount !== targetCheckpoint.recordCount
          )
            refuse('integrity', 'candidate records changed since the import')
          if (absent() > 0) refuse('integrity', 'a blob the records name is missing on the blob service')
          const activated = checked('AuthorityTransferProbe', {
            state: 'activated',
            cutoverId: route.cutoverId,
            authority: { authorityId, tenantId: route.tenantId, authorityEpoch: route.authorityEpoch },
            checkpoint: route.checkpoint,
          })
          db.prepare("UPDATE authority SET role = 'serving', epoch = ? WHERE id = 1").run(
            route.authorityEpoch,
          )
          db.prepare('UPDATE transfers SET outcome_input = ?, outcome = ? WHERE upgrade_id = ?').run(
            print,
            jcs(activated),
            input.upgradeId,
          )
          return activated
        })
      }),

    /**
     * Lifts the gate at the epoch after the fence, only onto the published recovery route for this
     * location and only while no target of the upgrade was activated. The fenced epoch never serves again.
     */
    abort: (request, context) =>
      host.attempt(context, async () => {
        const source = admit(context)
        const input = parse('AuthorityTransferControlAbortRequest', request)
        const print = fingerprint(input)
        const settled = () => {
          const row = transfer(input.upgradeId)
          if (!row?.fence) refuse('not_found', 'no fence was taken for this upgrade')
          if (row.outcome && row.outcome_input !== print)
            refuse('idempotency_conflict', 'upgrade was aborted by another request')
          return { row, fence: JSON.parse(row.fence) as Wire.AuthorityFence }
        }
        const { row, fence } = settled()
        if (row.outcome) return JSON.parse(row.outcome) as Wire.AuthorityTransferProbe
        if (fence.fenceId !== input.expectedFenceId) refuse('revision_conflict', 'fence id does not match')
        const route = routeOf(input.recoveryRoute)
        if (
          route.logicalAuthorityId !== authorityId ||
          route.tenantId !== fence.source.tenantId ||
          route.locationRef !== source.locationRef ||
          route.authorityEpoch !== fence.fenceEpoch + 1
        )
          refuse('revision_conflict', 'recovery route does not restore this store')
        if (await published(source, route, input.upgradeId, context))
          refuse('revision_conflict', 'a target of this upgrade was activated')
        return host.transaction(() => {
          const again = settled()
          if (again.row.outcome) return JSON.parse(again.row.outcome) as Wire.AuthorityTransferProbe
          const current = role()
          if (current.role !== 'fenced' || current.epoch !== fence.fenceEpoch)
            refuse('revision_conflict', 'store is no longer fenced at the fence epoch')
          const aborted = checked('AuthorityTransferProbe', {
            state: 'aborted',
            source: fence.source,
            restoredEpoch: route.authorityEpoch,
          })
          db.prepare("UPDATE authority SET role = 'serving', epoch = ? WHERE id = 1").run(
            route.authorityEpoch,
          )
          db.prepare('UPDATE transfers SET outcome_input = ?, outcome = ? WHERE upgrade_id = ?').run(
            print,
            jcs(aborted),
            input.upgradeId,
          )
          return aborted
        })
      }),

    /** Reads only committed state, so a reopened store reports what it reported before. */
    probe: (request, context) =>
      host.attempt(context, (): Wire.AuthorityTransferProbe => {
        const target = admit(context)
        const { upgradeId } = parse('AuthorityTransferControlProbeRequest', request)
        const row = transfer(upgradeId)
        if (row?.outcome) return JSON.parse(row.outcome) as Wire.AuthorityTransferProbe
        if (row?.imported && row.source) {
          const source = JSON.parse(row.source) as Wire.AuthorityExport
          const { checkpoint } = source
          const { targetCheckpoint } = JSON.parse(row.imported) as ImportResult
          // A target never sees the fence itself; the export it imported names everything the fence held.
          const fence = {
            upgradeId,
            source: {
              authorityId: checkpoint.authorityId,
              tenantId: target.tenantId,
              authorityEpoch: checkpoint.authorityEpoch,
            },
            fenceId: source.fenceId,
            fenceEpoch: checkpoint.authorityEpoch,
            checkpoint,
            writerCredentialsRevoked: true,
          }
          return { state: 'imported', fence, exportDigest: fingerprint(source), targetCheckpoint }
        }
        if (row?.fence) return { state: 'fenced', fence: JSON.parse(row.fence) as Wire.AuthorityFence }
        return { state: 'absent' }
      }),
  }

  return {
    control,
    /** The bytes this store exported under `ref`, in slices of at most 1 MiB; the importer checks them. */
    async *readExport(ref: Wire.BlobRef, context: CallContext): AsyncGenerator<Uint8Array> {
      admit(context)
      const data = stored(ref)
      for (let at = 0; at < data.byteLength; at += SLICE_BYTES) yield data.subarray(at, at + SLICE_BYTES)
    },
  }
}

/**
 * A reference descriptor: one operation per remote catalog method of the binding's contract whose
 * required feature is declared, except the `omitted` ones the reference does not offer (the blob store
 * has no upload chain for stage); local read methods are ports.
 */
export function referenceDescriptor(
  binding: Wire.BindingRef,
  features: readonly string[],
  packageDigest: Wire.Digest,
  offer: Readonly<{ omitted: readonly string[]; requires: readonly Wire.ServiceRequirement[] }>,
): Wire.ProviderDescriptor {
  const contract = binding.contract as 'agh.blob' | 'agh.artifacts'
  const catalog: Readonly<{
    major: number
    methods: Readonly<Record<string, { kind?: string; local?: boolean; requiredFeature?: string }>>
  }> = RuntimeServiceCatalog[contract]
  const schemas: Readonly<Record<string, { input: Wire.SchemaRef; output: Wire.SchemaRef }>> =
    RuntimeMethodSchemaRefs[contract]
  const checked = validateRuntime('ProviderDescriptor', {
    providerId: binding.providerId,
    contract,
    major: catalog.major,
    logicalName: binding.logicalName,
    packageVersion: '1.0.0',
    packageDigest,
    features,
    scope: 'runtime',
    configSchema: schemaRef(`agh.reference.${contract.slice('agh.'.length)}/config@1`),
    requires: offer.requires,
    capabilities: [],
    recovery: 'R1',
    isolation: ['trusted-in-process'],
    stateCodecs: [],
    activationMode: 'eager',
    operations: Object.entries(catalog.methods).flatMap(([method, { kind, local, requiredFeature }]) =>
      local || offer.omitted.includes(method) || (requiredFeature && !features.includes(requiredFeature))
        ? []
        : [
            {
              method,
              kind,
              inputSchema: schemas[method]?.input,
              outputSchema: schemas[method]?.output,
              requiredCapabilities: [],
              retrySafety: kind === 'query' ? 'read-only' : kind === 'maintenance' ? 'idempotent' : 'never',
            },
          ],
    ),
  })
  if (!checked.ok) throw new Error(`invalid reference ${contract} descriptor`)
  return checked.value
}
