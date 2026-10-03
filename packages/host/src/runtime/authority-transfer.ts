import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { BlobReadPort, CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { type RuntimeErrorDetails, type RuntimeWireTypes, validateRuntime } from '@agnes/protocol/runtime'
import { type AuthorityCopy, type AuthorityCopyMethods, openAuthorityCopy } from './authority-copy.js'

type Detail = keyof typeof RuntimeErrorDetails

/** What the Host's maintenance assembly tells one store about its place in the authority directory. */
export type TransferMaintenance = Readonly<{
  /** The Host's check that the caller is the maintenance controller. */
  authorize(context: CallContext): boolean
  tenantId: Wire.Id
  /** The directory location this store serves. */
  locationRef: Wire.Id
  /**
   * The route the directory durably holds for this authority, and whether a target of the upgrade
   * has been activated.
   */
  readRoute(
    request: Readonly<{ logicalAuthorityId: Wire.Id; upgradeId: Wire.Id }>,
    context: CallContext,
  ): Promise<Outcome<Readonly<{ route: Wire.AuthorityRoute; targetActivated: boolean }>>>
  /** Reads the source authority's export chunks and content while this store imports them. */
  sourceBlobs: Pick<BlobReadPort, 'openRead'>
  /** The verify request carries no plan fingerprint, so the maintenance assembly supplies it. */
  planFingerprint(upgradeId: Wire.Id, context: CallContext): Promise<Outcome<Wire.Digest>>
}>

export type AuthorityRole = 'serving' | 'fenced' | 'candidate' | 'aborted'

export type AuthoritySource = Readonly<{
  authorityId: Wire.Id
  /** Business tables and their key order. A checkpoint covers exactly these rows. */
  tables: Readonly<Record<string, string>>
  /** The table whose `seq` head is the store's deletion or revocation watermark. */
  log: string
  bridges(): Wire.AuthorityCheckpoint['bridgeWatermarks']
  error(detail: Detail, message: string): Wire.RuntimeError
  Refusal: new (error: Wire.RuntimeError) => Error
  maintenance?: TransferMaintenance
  /** A new store opened at a transfer target starts as a candidate; an existing store keeps its role. */
  target?: boolean
  now?: () => number
  /** Without it, export, import, verify and activate are refused as not supported. */
  copy?: AuthorityCopy
}>

/** One store's authority: the gate in front of its business writes and both sides of a transfer. */
export type Authority = Readonly<
  {
    /** A business write. Refused as blocked unless the store still serves at the epoch it holds. */
    write<T>(body: () => T): T
    role(): AuthorityRole
    fence(request: unknown, context: CallContext): Wire.AuthorityFence
    probe(request: unknown, context: CallContext): Wire.AuthorityTransferProbe
    abort(request: unknown, context: CallContext): Promise<Wire.AuthorityTransferProbe>
  } & AuthorityCopyMethods
>

/** The maintenance namespace: never business state, never part of a checkpoint. */
const DDL = [
  `CREATE TABLE IF NOT EXISTS maintenance_authority (
    id INTEGER PRIMARY KEY CHECK (id = 1), authority_id TEXT NOT NULL, epoch INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('serving', 'fenced', 'candidate', 'aborted')))`,
  `CREATE TABLE IF NOT EXISTS maintenance_transfers (
    upgrade_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, fence TEXT NOT NULL, watermark INTEGER NOT NULL,
    abort_fingerprint TEXT, aborted TEXT)`,
]

type AuthorityRow = { authority_id: string; epoch: number; role: AuthorityRole }
export type TransferRow = {
  fingerprint: string
  fence: string
  watermark: number
  abort_fingerprint: string | null
  aborted: string | null
}

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

/**
 * Opens the authority row of a store that serves at epoch 1 until a transfer moves it, or of a new
 * transfer target that stays a candidate until activated. A fence installs the write gate, takes the
 * checkpoint and records itself in one transaction; only an abort onto the published recovery route
 * lifts the gate, at the next epoch.
 */
export function openAuthority(db: DatabaseSync, source: AuthoritySource): Authority {
  const refuse = (detail: Detail, message: string): never => {
    throw new source.Refusal(source.error(detail, message))
  }
  const parse = <K extends keyof RuntimeWireTypes>(name: K, value: unknown): RuntimeWireTypes[K] => {
    const result = validateRuntime(name, value)
    return result.ok ? result.value : refuse('invalid_request', `${name} does not match its schema`)
  }
  const checked = <K extends keyof RuntimeWireTypes>(name: K, value: unknown): RuntimeWireTypes[K] => {
    const result = validateRuntime(name, value)
    return result.ok ? result.value : refuse('internal_error', `${name} failed its own schema`)
  }
  for (const statement of DDL) db.exec(statement)
  db.prepare(
    'INSERT OR IGNORE INTO maintenance_authority (id, authority_id, epoch, role) VALUES (1, ?, ?, ?)',
  ).run(source.authorityId, source.target ? 0 : 1, source.target ? 'candidate' : 'serving')
  const row = () =>
    db
      .prepare('SELECT authority_id, epoch, role FROM maintenance_authority WHERE id = 1')
      .get() as AuthorityRow
  if (row().authority_id !== source.authorityId) throw new Error('store belongs to another authority')
  let epoch = row().epoch

  const transaction = <T>(gated: boolean, body: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (gated) {
        const current = row()
        if (current.role !== 'serving' || current.epoch !== epoch)
          refuse('blocked', 'authority is fenced for a transfer or serves at another epoch')
      }
      const result = body()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const admit = (context: CallContext) => {
    const maintenance =
      source.maintenance ?? refuse('operation_not_supported', 'no maintenance authority is configured')
    if (!maintenance.authorize(context))
      refuse('permission_denied', 'caller is not the maintenance controller')
    return maintenance
  }

  const transfer = (upgradeId: Wire.Id) =>
    db
      .prepare(
        'SELECT fingerprint, fence, watermark, abort_fingerprint, aborted FROM maintenance_transfers WHERE upgrade_id = ?',
      )
      .get(upgradeId) as TransferRow | undefined

  /** Streams every business row in key order; a byte cell enters as its own digest. */
  const snapshot = () => {
    const hash = createHash('sha256')
    let recordCount = 0
    for (const [table, key] of Object.entries(source.tables)) {
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).iterate() as Iterable<
        Record<string, unknown>
      >
      for (const record of rows) {
        recordCount += 1
        const cells = Object.values(record).map((cell) =>
          cell instanceof Uint8Array ? { sha256: sha256(cell) } : cell,
        )
        hash.update(`${JSON.stringify([table, ...cells])}\n`)
      }
    }
    return { snapshotDigest: hash.digest('hex'), recordCount }
  }

  const head = () =>
    (db.prepare(`SELECT COALESCE(MAX(seq), 0) AS head FROM ${source.log}`).get() as { head: number }).head

  const copy = openAuthorityCopy({
    db,
    source,
    refuse,
    parse,
    checked,
    admit,
    transaction,
    role: () => row().role,
    transfer,
    snapshot,
    head,
    serve: (next) => {
      epoch = next
    },
  })

  return {
    write: (body) => transaction(true, body),
    role: () => row().role,
    export: copy.export,
    exportPage: copy.exportPage,
    import: copy.import,
    verify: copy.verify,
    activate: copy.activate,

    fence(request, context) {
      const maintenance = admit(context)
      const input = parse('AuthorityTransferControlFenceRequest', request)
      const fingerprint = sha256(jcs(input))
      return transaction(false, () => {
        const prior = transfer(input.upgradeId)
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            refuse('idempotency_conflict', 'upgrade id already names another fence')
          return JSON.parse(prior.fence) as Wire.AuthorityFence
        }
        const current = row()
        const { expected } = input
        if (
          current.role !== 'serving' ||
          current.epoch !== epoch ||
          expected.authorityId !== current.authority_id ||
          expected.tenantId !== maintenance.tenantId ||
          expected.authorityEpoch !== current.epoch
        )
          refuse('revision_conflict', 'authority is not serving as expected')
        const fence = checked('AuthorityFence', {
          upgradeId: input.upgradeId,
          source: expected,
          fenceId: randomUUID(),
          fenceEpoch: current.epoch,
          checkpoint: {
            authorityId: current.authority_id,
            authorityEpoch: current.epoch,
            checkpointId: randomUUID(),
            ...snapshot(),
            bridgeWatermarks: source.bridges(),
          },
          writerCredentialsRevoked: true,
        })
        db.prepare("UPDATE maintenance_authority SET role = 'fenced' WHERE id = 1").run()
        db.prepare(
          'INSERT INTO maintenance_transfers (upgrade_id, fingerprint, fence, watermark) VALUES (?, ?, ?, ?)',
        ).run(input.upgradeId, fingerprint, JSON.stringify(fence), head())
        return fence
      })
    },

    probe(request, context) {
      const maintenance = admit(context)
      const { upgradeId } = parse('AuthorityTransferControlProbeRequest', request)
      const prior = transfer(upgradeId)
      if (!prior) return copy.probe(upgradeId, maintenance)
      if (prior.aborted !== null) return JSON.parse(prior.aborted) as Wire.AuthorityTransferProbe
      return { state: 'fenced', fence: JSON.parse(prior.fence) as Wire.AuthorityFence }
    },

    async abort(request, context) {
      const maintenance = admit(context)
      const input = parse('AuthorityTransferControlAbortRequest', request)
      const fingerprint = sha256(jcs(input))
      const settled = (): { fence: Wire.AuthorityFence; done?: Wire.AuthorityTransferProbe } => {
        const prior = transfer(input.upgradeId) ?? refuse('not_found', 'no fence was taken for this upgrade')
        const fence = JSON.parse(prior.fence) as Wire.AuthorityFence
        if (prior.aborted === null) return { fence }
        if (prior.abort_fingerprint !== fingerprint)
          refuse('idempotency_conflict', 'upgrade was aborted by another request')
        return { fence, done: JSON.parse(prior.aborted) as Wire.AuthorityTransferProbe }
      }
      const first = settled()
      if (first.done) return first.done
      const { fence } = first
      if (fence.fenceId !== input.expectedFenceId) refuse('revision_conflict', 'fence id does not match')
      const route =
        input.recoveryRoute.kind === 'inline'
          ? parse('AuthorityRoute', input.recoveryRoute.value)
          : refuse('invalid_request', 'recovery route must be inline')
      if (
        route.logicalAuthorityId !== fence.source.authorityId ||
        route.tenantId !== fence.source.tenantId ||
        route.locationRef !== maintenance.locationRef
      )
        refuse('revision_conflict', 'recovery route does not name this authority and location')
      // An abort never reopens the fenced epoch: the recovery route takes the next one.
      const restored = fence.fenceEpoch + 1
      if (route.authorityEpoch !== restored)
        refuse('revision_conflict', 'recovery route must take the epoch after the fence')
      const published = await maintenance.readRoute(
        { logicalAuthorityId: route.logicalAuthorityId, upgradeId: input.upgradeId },
        context,
      )
      if (!published.ok) throw new source.Refusal(published.error)
      if (jcs(published.value.route) !== jcs(route))
        refuse('revision_conflict', 'recovery route is not the published route')
      if (published.value.targetActivated)
        refuse('revision_conflict', 'a target of this upgrade was activated')
      let adopted = false
      const result = transaction(false, () => {
        const again = settled()
        if (again.done) return again.done
        const current = row()
        if (current.role !== 'fenced' || current.epoch !== fence.fenceEpoch)
          refuse('revision_conflict', 'authority is no longer fenced at this epoch')
        const aborted = checked('AuthorityTransferProbe', {
          state: 'aborted',
          source: fence.source,
          restoredEpoch: restored,
        })
        db.prepare("UPDATE maintenance_authority SET role = 'serving', epoch = ? WHERE id = 1").run(restored)
        db.prepare(
          'UPDATE maintenance_transfers SET abort_fingerprint = ?, aborted = ? WHERE upgrade_id = ?',
        ).run(fingerprint, JSON.stringify(aborted), input.upgradeId)
        adopted = true
        return aborted
      })
      if (adopted) epoch = restored
      return result
    },
  }
}
