import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { CallContext } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import type { RuntimeErrorDetails, RuntimeWireTypes } from '@agnes/protocol/runtime'
import type {
  AuthorityRole,
  AuthoritySource,
  TransferMaintenance,
  TransferRow,
} from './authority-transfer.js'
import { inlineData } from './maintenance/authority-publication.js'
import {
  ASSET_INDEX,
  buildExportIndex,
  EXPORT_INDEX,
  ExportIndexError,
  exportIndexPage,
  type IndexCheckpoint,
  type IndexStorage,
  indexDigest,
  indexItemKey,
  initialIndexCheckpoint,
  verifyExportIndex,
  walkExportIndex,
} from './migration/export-index.js'

type Detail = keyof typeof RuntimeErrorDetails

/** What a store lends the transfer engine so its rows and content can move to another location. */
export type AuthorityCopy = Readonly<{
  /** Collection ids are `<collection>.<table>`. */
  collection: string
  /** Immutable, content-addressed storage of this store's export chunks and index pages. */
  storage(upgradeId: Wire.Id): IndexStorage
  assets: Readonly<{
    /** One reference per content object a business row still uses, in any order. */
    list(upgradeId: Wire.Id): Iterable<Wire.DataRef>
    /** Whether this store holds the referenced bytes intact. */
    present(ref: Wire.BlobRef): Promise<boolean>
    /** Stores the referenced bytes read from the source; nothing to do when they are present. */
    copy(ref: Wire.BlobRef, read: (ref: Wire.BlobRef) => AsyncIterable<Uint8Array>): Promise<void>
  }>
}>

type Method<K extends keyof RuntimeWireTypes> = (
  request: unknown,
  context: CallContext,
) => Promise<RuntimeWireTypes[K]>

export type AuthorityCopyMethods = Readonly<{
  export: Method<'AuthorityExport'>
  exportPage: Method<'AuthorityTransferControlExportPageResult'>
  import: Method<'AuthorityTransferControlImportResult'>
  verify: Method<'MigrationValidation'>
  activate: Method<'AuthorityTransferProbe'>
}>

/** The engine pieces the copy shares with the fence. */
type Kit = Readonly<{
  db: DatabaseSync
  source: AuthoritySource
  refuse(detail: Detail, message: string): never
  parse<K extends keyof RuntimeWireTypes>(name: K, value: unknown): RuntimeWireTypes[K]
  checked<K extends keyof RuntimeWireTypes>(name: K, value: unknown): RuntimeWireTypes[K]
  admit(context: CallContext): TransferMaintenance
  transaction<T>(gated: boolean, body: () => T): T
  role(): AuthorityRole
  transfer(upgradeId: Wire.Id): TransferRow | undefined
  snapshot(): { snapshotDigest: string; recordCount: number }
  /** The head of the deletion or revocation log. */
  head(): number
  /** Opens the write gate at the activated epoch. */
  serve(epoch: number): void
}>

/** The maintenance namespace of the copy; the fence's own tables predate it and stay unchanged. */
const DDL = [
  `CREATE TABLE IF NOT EXISTS maintenance_exports (
    upgrade_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, export TEXT NOT NULL)`,
  // The assets of the export being built, read back in index key order.
  'CREATE TABLE IF NOT EXISTS maintenance_export_assets (key TEXT PRIMARY KEY, item TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS maintenance_imports (
    upgrade_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, source TEXT NOT NULL, assets TEXT NOT NULL,
    manifest TEXT NOT NULL, result TEXT, activate_fingerprint TEXT, activated TEXT)`,
]

type ImportRow = {
  fingerprint: string
  source: string
  assets: string
  manifest: string
  result: string | null
  activate_fingerprint: string | null
  activated: string | null
}

const PART_BYTES = 4 * 1024 * 1024
const PART_ROWS = 10_000
/** A part of this engine holds at most one row past the part ceiling, and a row stays far below this. */
const MAX_PART_BYTES = 32 * 1024 * 1024
/** Cursor and limit refusals are the caller's; every other index refusal is about the bytes. */
const REQUEST_REFUSALS = new Set(['cursor_invalid', 'page_limit', 'checkpoint_invalid'])

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const recordKey = (ordinal: number) => String(ordinal).padStart(16, '0')

/** The fence an export was taken under, as the source recorded it. */
const fenceOf = (exported: Wire.AuthorityExport, tenantId: Wire.Id): Wire.AuthorityFence => ({
  upgradeId: exported.upgradeId,
  source: {
    authorityId: exported.checkpoint.authorityId,
    tenantId,
    authorityEpoch: exported.checkpoint.authorityEpoch,
  },
  fenceId: exported.fenceId,
  fenceEpoch: exported.checkpoint.authorityEpoch,
  checkpoint: exported.checkpoint,
  writerCredentialsRevoked: true,
})

/**
 * Export, import, verify and activate. A source exports its fenced rows as JSONL parts and its content
 * as required assets, both under bounded index trees. A target imports them resumably: each part's
 * rows commit with the index checkpoint that accepted it, so a rerun never repeats a row.
 */
export function openAuthorityCopy(kit: Kit): AuthorityCopyMethods & {
  probe(upgradeId: Wire.Id, maintenance: TransferMaintenance): Wire.AuthorityTransferProbe
} {
  const { db, source, refuse, parse, checked } = kit
  for (const statement of DDL) db.exec(statement)
  const now = source.now ?? (() => Date.now())
  const copying = () => source.copy ?? refuse('operation_not_supported', 'this store cannot copy its rows')

  let tail: Promise<unknown> = Promise.resolve()
  /** Export and import await I/O between their steps, so one runs at a time in this process. */
  const serial = <T>(body: () => Promise<T>): Promise<T> => {
    const next = tail.then(body, body)
    tail = next.catch(() => undefined)
    return next
  }

  const exported = (upgradeId: Wire.Id) =>
    db.prepare('SELECT fingerprint, export FROM maintenance_exports WHERE upgrade_id = ?').get(upgradeId) as
      | { fingerprint: string; export: string }
      | undefined
  const imported = (upgradeId: Wire.Id) =>
    db.prepare('SELECT * FROM maintenance_imports WHERE upgrade_id = ?').get(upgradeId) as
      | ImportRow
      | undefined

  /** A table's columns in order, and the provisional schema of its rows. */
  const tableSchema = (collection: string, table: string) => {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      ({ name }) => name,
    )
    const schema: Wire.SchemaRef = {
      typeId: `agh.host.${collection}/${table}-rows@1`,
      revision: 1,
      digest: sha256(JSON.stringify(columns)),
    }
    return { columns, schema }
  }

  const decodeRow = (line: string, width: number): SQLInputValue[] => {
    let cells: unknown
    try {
      cells = JSON.parse(line)
    } catch {
      return refuse('integrity', 'export row is not JSON')
    }
    if (!Array.isArray(cells) || cells.length !== width)
      return refuse('integrity', 'export row does not match its schema')
    return cells.map((cell: unknown) => {
      if (cell === null || typeof cell === 'string' || typeof cell === 'number') return cell
      const bytes = (cell as { $bytes?: unknown } | null)?.$bytes
      return typeof bytes === 'string' && Object.keys(cell as object).length === 1
        ? Buffer.from(bytes, 'base64')
        : refuse('integrity', 'export row has a cell of no known type')
    })
  }

  /** Reads the source's bytes through the maintenance lender, keeping the lender's own refusal. */
  const lender = (maintenance: TransferMaintenance, context: CallContext) => {
    let failure: Wire.RuntimeError | undefined
    const fail = (error: Wire.RuntimeError): never => {
      failure = error
      throw new source.Refusal(error)
    }
    const storage: IndexStorage = {
      put: async () => refuse('internal_error', 'a target never writes the source index'),
      async *read(ref) {
        const opened = await maintenance.sourceBlobs.openRead({ ref, offset: 0 }, context)
        if (!opened.ok) return fail(opened.error)
        try {
          yield* opened.value.chunks
          const ended = await opened.value.ended
          if (!ended.ok) fail(ended.error)
        } finally {
          await opened.value.close()
        }
      },
    }
    /** A refused index is an integrity failure, unless a read from the lender failed first. */
    const walk = async <T>(body: () => Promise<T>): Promise<T> => {
      try {
        return await body()
      } catch (caught) {
        if (!(caught instanceof ExportIndexError)) throw caught
        if (failure) throw new source.Refusal(failure)
        return refuse('integrity', `source export index refused: ${caught.detailCode}`)
      }
    }
    return { storage, walk }
  }

  async function exportRows(request: unknown, context: CallContext): Promise<Wire.AuthorityExport> {
    kit.admit(context)
    const copy = copying()
    const input = parse('AuthorityTransferControlExportRequest', request)
    const fingerprint = sha256(jcs(input))
    return serial(async () => {
      const prior = exported(input.upgradeId)
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          refuse('idempotency_conflict', 'upgrade was exported under another fence')
        return JSON.parse(prior.export) as Wire.AuthorityExport
      }
      const fenced =
        kit.transfer(input.upgradeId) ?? refuse('not_found', 'no fence was taken for this upgrade')
      const fence = JSON.parse(fenced.fence) as Wire.AuthorityFence
      if (fence.fenceId !== input.fenceId || fenced.aborted !== null || kit.role() !== 'fenced')
        refuse('revision_conflict', 'authority is not held by this fence')
      const current = kit.snapshot()
      if (
        current.snapshotDigest !== fence.checkpoint.snapshotDigest ||
        current.recordCount !== fence.checkpoint.recordCount
      )
        refuse('internal_error', 'business rows changed behind the fence')
      const storage = copy.storage(input.upgradeId)
      // Parts are indexed by collection id bytes, then part index.
      const tables = Object.keys(source.tables)
        .map((table) => ({ table, collectionId: `${copy.collection}.${table}` }))
        .sort((a, b) => Buffer.compare(Buffer.from(a.collectionId), Buffer.from(b.collectionId)))
      let partCount = 0
      async function* parts(): AsyncGenerator<Wire.AuthorityExportPart> {
        for (const { table, collectionId } of tables) {
          const { columns, schema } = tableSchema(copy.collection, table)
          let lines: string[] = []
          let size = 0
          let ordinal = 0
          let partIndex = 0
          const part = async () => {
            const stored = await storage.put(Buffer.from(lines.join('')), schema.typeId)
            const records = lines.length
            lines = []
            size = 0
            partCount += 1
            return checked('AuthorityExportPart', {
              collectionId,
              schema,
              partIndex: partIndex++,
              firstRecordKey: recordKey(ordinal - records + 1),
              lastRecordKey: recordKey(ordinal),
              records,
              contentDigest: indexDigest(stored),
              chunk: stored.kind === 'blob' ? stored.blob : null,
            })
          }
          const rows = db
            .prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${source.tables[table]}`)
            .iterate() as Iterable<Record<string, unknown>>
          for (const record of rows) {
            const line = `${JSON.stringify(
              columns.map((column) => {
                const cell = record[column]
                return cell instanceof Uint8Array ? { $bytes: Buffer.from(cell).toString('base64') } : cell
              }),
            )}\n`
            const bytes = Buffer.byteLength(line)
            if (lines.length === PART_ROWS || (lines.length > 0 && size + bytes > PART_BYTES))
              yield await part()
            lines.push(line)
            size += bytes
            ordinal += 1
          }
          if (lines.length > 0) yield await part()
        }
      }
      // Asset keys are digests, so the staged set reads back sorted without being held in memory.
      kit.transaction(false, () => {
        db.exec('DELETE FROM maintenance_export_assets')
        const stage = db.prepare('INSERT OR IGNORE INTO maintenance_export_assets (key, item) VALUES (?, ?)')
        for (const ref of copy.assets.list(input.upgradeId))
          stage.run(indexItemKey(ASSET_INDEX, ref), JSON.stringify(ref))
      })
      async function* assets(): AsyncGenerator<Wire.DataRef> {
        const rows = db
          .prepare('SELECT item FROM maintenance_export_assets ORDER BY key')
          .iterate() as Iterable<{ item: string }>
        for (const { item } of rows) yield JSON.parse(item) as Wire.DataRef
      }
      const manifestRoot = await buildExportIndex(EXPORT_INDEX, parts(), storage)
      const requiredAssetsRoot = await buildExportIndex(ASSET_INDEX, assets(), storage)
      db.exec('DELETE FROM maintenance_export_assets')
      const result = checked('AuthorityExport', {
        upgradeId: input.upgradeId,
        fenceId: input.fenceId,
        checkpoint: fence.checkpoint,
        collectionCount: tables.length,
        partCount,
        manifestRoot,
        requiredAssetsRoot,
        deletionWatermark: fenced.watermark,
      })
      db.prepare('INSERT INTO maintenance_exports (upgrade_id, fingerprint, export) VALUES (?, ?, ?)').run(
        input.upgradeId,
        fingerprint,
        JSON.stringify(result),
      )
      return result
    })
  }

  async function exportPage(
    request: unknown,
    context: CallContext,
  ): Promise<Wire.AuthorityTransferControlExportPageResult> {
    kit.admit(context)
    const copy = copying()
    const input = parse('AuthorityTransferControlExportPageRequest', request)
    const stored = exported(input.upgradeId) ?? refuse('not_found', 'upgrade was not exported')
    const result = JSON.parse(stored.export) as Wire.AuthorityExport
    if (result.fenceId !== input.fenceId || indexDigest(result.manifestRoot) !== input.manifestDigest)
      refuse('revision_conflict', 'export does not match this fence and manifest')
    const fenced = kit.transfer(input.upgradeId) ?? refuse('not_found', 'no fence was taken for this upgrade')
    const fence = JSON.parse(fenced.fence) as Wire.AuthorityFence
    try {
      const page = await exportIndexPage(
        result.manifestRoot,
        EXPORT_INDEX,
        sha256(jcs(fence)),
        input.cursor,
        input.limit,
        copy.storage(input.upgradeId),
      )
      return checked('AuthorityTransferControlExportPageResult', {
        ...page,
        snapshot: fence.checkpoint.checkpointId,
      })
    } catch (caught) {
      if (!(caught instanceof ExportIndexError)) throw caught
      const detail = REQUEST_REFUSALS.has(caught.detailCode) ? 'invalid_request' : 'integrity'
      return refuse(detail, `export index refused: ${caught.detailCode}`)
    }
  }

  async function importRows(
    request: unknown,
    context: CallContext,
  ): Promise<Wire.AuthorityTransferControlImportResult> {
    const maintenance = kit.admit(context)
    const copy = copying()
    const input = parse('AuthorityTransferControlImportRequest', request)
    const fingerprint = sha256(jcs(input))
    const { source: from, upgradeId } = input
    return serial(async () => {
      const prior = imported(upgradeId)
      if (prior && prior.fingerprint !== fingerprint)
        refuse('idempotency_conflict', 'upgrade id already names another import')
      if (prior?.result) return JSON.parse(prior.result) as Wire.AuthorityTransferControlImportResult
      if (!prior) {
        if (
          input.targetLocationRef !== maintenance.locationRef ||
          from.checkpoint.authorityId !== source.authorityId
        )
          refuse('revision_conflict', 'import names another location or authority')
        const fenceDigest = sha256(jcs(fenceOf(from, maintenance.tenantId)))
        kit.transaction(false, () => {
          const taken = db.prepare('SELECT 1 FROM maintenance_imports').get()
          if (kit.role() !== 'candidate' || taken || kit.snapshot().recordCount !== 0)
            refuse('revision_conflict', 'only an empty candidate takes an import')
          db.prepare(
            'INSERT INTO maintenance_imports (upgrade_id, fingerprint, source, assets, manifest) VALUES (?, ?, ?, ?, ?)',
          ).run(
            upgradeId,
            fingerprint,
            jcs(from),
            JSON.stringify(initialIndexCheckpoint(from.requiredAssetsRoot, ASSET_INDEX, fenceDigest)),
            JSON.stringify(initialIndexCheckpoint(from.manifestRoot, EXPORT_INDEX, fenceDigest)),
          )
        })
      }
      const row = imported(upgradeId) ?? refuse('internal_error', 'import was not recorded')
      const { storage, walk } = lender(maintenance, context)
      const save = (column: 'assets' | 'manifest', next: IndexCheckpoint) =>
        db
          .prepare(`UPDATE maintenance_imports SET ${column} = ? WHERE upgrade_id = ?`)
          .run(JSON.stringify(next), upgradeId)

      await walk(() =>
        verifyExportIndex(
          from.requiredAssetsRoot,
          JSON.parse(row.assets) as IndexCheckpoint,
          storage,
          async (item, next) => {
            const ref = item as Wire.DataRef
            // An inline asset carries its own bytes.
            if (ref.kind === 'blob') await copy.assets.copy(ref.blob, (blob) => storage.read(blob))
            save('assets', next)
          },
        ),
      )
      const tables = new Map(
        Object.keys(source.tables).map((table) => [
          `${copy.collection}.${table}`,
          { table, ...tableSchema(copy.collection, table) },
        ]),
      )
      const manifest = await walk(() =>
        verifyExportIndex(
          from.manifestRoot,
          JSON.parse(row.manifest) as IndexCheckpoint,
          storage,
          async (item, next) => {
            const part = item as Wire.AuthorityExportPart
            const target = tables.get(part.collectionId)
            // Collection schemas across implementations are not defined yet.
            if (!target || jcs(target.schema) !== jcs(part.schema))
              return refuse('operation_not_supported', 'export part has a collection schema this store lacks')
            if (part.chunk.bytes > MAX_PART_BYTES)
              refuse('integrity', 'export part is larger than any part this engine writes')
            const chunk = Buffer.alloc(part.chunk.bytes)
            const hash = createHash('sha256')
            let size = 0
            for await (const bytes of storage.read(part.chunk)) {
              if (size + bytes.byteLength > chunk.byteLength)
                refuse('integrity', 'export part runs past its size')
              chunk.set(bytes, size)
              hash.update(bytes)
              size += bytes.byteLength
            }
            if (size !== chunk.byteLength || hash.digest('hex') !== part.contentDigest)
              refuse('integrity', 'export part bytes do not match their digest')
            const lines = chunk.toString('utf8').split('\n')
            if (lines.pop() !== '' || lines.length !== part.records)
              refuse('integrity', 'export part does not hold its declared records')
            const rows = lines.map((line) => decodeRow(line, target.columns.length))
            const insert = db.prepare(
              `INSERT INTO ${target.table} (${target.columns.join(', ')}) VALUES (${target.columns.map(() => '?').join(', ')})`,
            )
            kit.transaction(false, () => {
              for (const cells of rows) insert.run(...cells)
              save('manifest', next)
            })
          },
        ),
      )
      if (manifest.consumed !== from.partCount)
        refuse('integrity', 'export manifest does not hold its declared parts')
      const current = kit.snapshot()
      const result = checked('AuthorityTransferControlImportResult', {
        targetCheckpoint: {
          authorityId: source.authorityId,
          authorityEpoch: from.checkpoint.authorityEpoch,
          checkpointId: randomUUID(),
          ...current,
          bridgeWatermarks: source.bridges(),
        },
        candidateRef: inlineData(
          { upgradeId, locationRef: maintenance.locationRef, ...current },
          'agh.host.transfer/candidate@1',
        ),
      })
      db.prepare('UPDATE maintenance_imports SET result = ? WHERE upgrade_id = ?').run(
        JSON.stringify(result),
        upgradeId,
      )
      return result
    })
  }

  const finished = (upgradeId: Wire.Id) => {
    const row = imported(upgradeId)
    return row?.result ? row : refuse('not_found', 'no finished import for this upgrade')
  }

  async function verify(request: unknown, context: CallContext): Promise<Wire.MigrationValidation> {
    const maintenance = kit.admit(context)
    const copy = copying()
    const input = parse('AuthorityTransferControlVerifyRequest', request)
    const row = finished(input.upgradeId)
    const { candidateRef } = JSON.parse(row.result ?? 'null') as Wire.AuthorityTransferControlImportResult
    if (row.source !== jcs(input.source) || jcs(candidateRef) !== jcs(input.candidateRef))
      refuse('revision_conflict', 'import does not match this source and candidate')
    const { checkpoint, deletionWatermark, requiredAssetsRoot } = input.source
    const current = kit.snapshot()
    const { storage, walk } = lender(maintenance, context)
    let assets = 0
    let present = 0
    await walk(async () => {
      for await (const { item } of walkExportIndex(requiredAssetsRoot, ASSET_INDEX, storage)) {
        const ref = item as Wire.DataRef
        assets += 1
        if (ref.kind === 'inline' || (await copy.assets.present(ref.blob))) present += 1
      }
    })
    const check = (checkId: string, expected: Wire.JsonValue, actual: Wire.JsonValue) => ({
      checkId,
      passed: jcs(expected) === jcs(actual),
      evidence: inlineData({ expected, actual }, 'agh.host.transfer/check-evidence@1'),
    })
    const checks = [
      check('snapshot-digest', checkpoint.snapshotDigest, current.snapshotDigest),
      check('record-count', checkpoint.recordCount, current.recordCount),
      check('required-assets', assets, present),
      check('deletion-watermark', deletionWatermark, kit.head()),
    ]
    const plan = await maintenance.planFingerprint(input.upgradeId, context)
    if (!plan.ok) throw new source.Refusal(plan.error)
    return checked('MigrationValidation', {
      upgradeId: input.upgradeId,
      planFingerprint: plan.value,
      candidateDigest: indexDigest(input.candidateRef),
      sourceSnapshotDigest: checkpoint.snapshotDigest,
      checkedAt: new Date(now()).toISOString(),
      checks,
      validatorBindings: [],
      accepted: checks.every(({ passed }) => passed),
    })
  }

  async function activate(request: unknown, context: CallContext): Promise<Wire.AuthorityTransferProbe> {
    const maintenance = kit.admit(context)
    copying()
    const input = parse('AuthorityTransferControlActivateRequest', request)
    const fingerprint = sha256(jcs(input))
    const settled = (): { row: ImportRow; done?: Wire.AuthorityTransferProbe } => {
      const row = finished(input.upgradeId)
      if (row.activated === null) return { row }
      if (row.activate_fingerprint !== fingerprint)
        refuse('idempotency_conflict', 'upgrade was activated by another request')
      return { row, done: JSON.parse(row.activated) as Wire.AuthorityTransferProbe }
    }
    const first = settled()
    if (first.done) return first.done
    const from = JSON.parse(first.row.source) as Wire.AuthorityExport
    const route =
      input.publishedRoute.kind === 'inline'
        ? parse('AuthorityRoute', input.publishedRoute.value)
        : refuse('invalid_request', 'published route must be inline')
    if (
      route.logicalAuthorityId !== source.authorityId ||
      route.tenantId !== maintenance.tenantId ||
      route.locationRef !== maintenance.locationRef ||
      route.cutoverId !== input.cutoverId ||
      route.authorityEpoch <= from.checkpoint.authorityEpoch
    )
      refuse('revision_conflict', 'published route does not name this location after the fence')
    const published = await maintenance.readRoute(
      { logicalAuthorityId: route.logicalAuthorityId, upgradeId: input.upgradeId },
      context,
    )
    if (!published.ok) throw new source.Refusal(published.error)
    if (jcs(published.value.route) !== jcs(route))
      refuse('revision_conflict', 'published route is not the route the directory holds')
    let adopted = false
    const result = kit.transaction(false, () => {
      const again = settled()
      if (again.done) return again.done
      if (kit.role() !== 'candidate') refuse('revision_conflict', 'authority is no longer a candidate')
      db.prepare("UPDATE maintenance_authority SET role = 'serving', epoch = ? WHERE id = 1").run(
        route.authorityEpoch,
      )
      const activated = checked('AuthorityTransferProbe', {
        state: 'activated',
        cutoverId: input.cutoverId,
        authority: {
          authorityId: source.authorityId,
          tenantId: maintenance.tenantId,
          authorityEpoch: route.authorityEpoch,
        },
        checkpoint: {
          authorityId: source.authorityId,
          authorityEpoch: route.authorityEpoch,
          checkpointId: randomUUID(),
          ...kit.snapshot(),
          bridgeWatermarks: source.bridges(),
        },
      })
      db.prepare(
        'UPDATE maintenance_imports SET activate_fingerprint = ?, activated = ? WHERE upgrade_id = ?',
      ).run(fingerprint, JSON.stringify(activated), input.upgradeId)
      adopted = true
      return activated
    })
    if (adopted) kit.serve(route.authorityEpoch)
    return result
  }

  return {
    export: exportRows,
    exportPage,
    import: importRows,
    verify,
    activate,
    /** The target side of a probe: an unfinished import is still absent. */
    probe(upgradeId, maintenance) {
      const row = imported(upgradeId)
      if (row?.activated) return JSON.parse(row.activated) as Wire.AuthorityTransferProbe
      if (!row?.result) return { state: 'absent' }
      const from = JSON.parse(row.source) as Wire.AuthorityExport
      return checked('AuthorityTransferProbe', {
        state: 'imported',
        fence: fenceOf(from, maintenance.tenantId),
        exportDigest: sha256(row.source),
        targetCheckpoint: (JSON.parse(row.result) as Wire.AuthorityTransferControlImportResult)
          .targetCheckpoint,
      })
    },
  }
}
