import { types as utilTypes } from 'node:util'
import type { RuntimeTarget, RuntimeTargetArtifact, RuntimeTargetIdentity } from '@agnes/plugin-runtime/host'
import { decodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { withoutPackageRows } from '../composite-desired.js'
import { PluginConfigAuditStore } from './plugin-config-audit.js'
import { ensure, type TableHandle } from './table.js'

export type CompositeTargetReport = Readonly<{
  hash: string
  ok: boolean
  rows: readonly Readonly<{ id: string; state: string; reason?: string }>[]
}>

export type CompositeTargetFailure = Readonly<{
  generation: number
  digest: string
  identity: RuntimeTargetIdentity
  phase: string
  message: string
}>

export type CompositePackageFailure = Readonly<{
  digest: string
  phase: string
  message: string
  at: string
}>

export type CompositeTargetRevert = Readonly<{
  expectedDigest: string
  target: RuntimeTargetArtifact
  /** The packages the failure is held against; may be empty when nothing can be attributed. */
  packages: readonly string[]
  failure: Readonly<{ digest: string; phase: string; message: string }>
  at: string
}>

export type CompositeTargetAck = Readonly<{
  digest: string
  identity: RuntimeTargetIdentity
  generation: number
}>

const ARTIFACT_COLUMNS = Object.freeze([
  'desired_json',
  'previous_json',
  'last_good_json',
  'report_json',
  'last_failure_json',
  'acknowledged_json',
] as const)

function unavailable(): Error {
  return new Error('composite target store unavailable')
}

function freezeArtifact(value: RuntimeTargetArtifact): RuntimeTargetArtifact {
  decodeRuntimeTargetArtifact(value)
  return Object.freeze({
    encoding: 'base64',
    canonicalBase64: value.canonicalBase64,
    digest: value.digest,
    identity: Object.freeze({ ...value.identity }),
  })
}

function parseArtifact(value: unknown): RuntimeTargetArtifact | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return freezeArtifact(JSON.parse(value) as RuntimeTargetArtifact)
}

function parseJson<T>(value: unknown): T | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return JSON.parse(value) as T
}

type StoreRow = Record<(typeof ARTIFACT_COLUMNS)[number], unknown>

/**
 * The only durable composite-target authority. Probe-successful artifacts are stored as the original
 * canonical payload; callers must never rebuild a target after probe.
 */
export class CompositeTargetStore {
  readonly #table: TableHandle
  readonly #profile: string
  readonly #artifacts = new Map<string, RuntimeTargetArtifact>()
  readonly #targets = new WeakMap<RuntimeTargetArtifact, RuntimeTarget>()
  readonly configAudit: PluginConfigAuditStore
  readonly #desiredListeners = new Set<(artifact: RuntimeTargetArtifact) => void>()
  readonly #reportListeners = new Set<(report: CompositeTargetReport) => void>()

  constructor(capability: TableHandle, profile: string) {
    if (!profile) throw new TypeError('composite target profile is required')
    if (!capability || typeof capability !== 'object' || utilTypes.isProxy(capability)) throw unavailable()
    const descriptors = Object.getOwnPropertyDescriptors(capability)
    const method = (name: 'exec' | 'get' | 'all' | 'transaction') => {
      const value = descriptors[name]?.value
      if (typeof value !== 'function' || utilTypes.isProxy(value)) throw unavailable()
      return value
    }
    method('exec')
    method('get')
    method('all')
    method('transaction')
    // Invoke through the live capability so a crash-injection wrapper installed after construction
    // still participates in the same SQLite transaction and can roll back lastGood/report/ack.
    this.#table = Object.freeze({
      exec: (sql: string, params: unknown[] = []) => capability.exec(sql, params),
      get: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        capability.get<T>(sql, params),
      all: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        capability.all<T>(sql, params),
      transaction: <T>(fn: () => T) => capability.transaction(fn),
    }) as TableHandle
    this.#profile = profile
    this.configAudit = new PluginConfigAuditStore(this.#table, profile)
    ensure(
      this.#table,
      `CREATE TABLE IF NOT EXISTS composite_targets (
        profile TEXT PRIMARY KEY,
        desired_json TEXT,
        previous_json TEXT,
        last_good_json TEXT,
        report_json TEXT,
        last_failure_json TEXT,
        acknowledged_json TEXT
      )`,
    )
    ensure(
      this.#table,
      `CREATE TABLE IF NOT EXISTS composite_target_pins (
        profile TEXT NOT NULL,
        pin TEXT NOT NULL,
        PRIMARY KEY (profile, pin)
      )`,
    )
    ensure(
      this.#table,
      `CREATE TABLE IF NOT EXISTS composite_target_package_failures (
        profile TEXT NOT NULL,
        package_id TEXT NOT NULL,
        failure_json TEXT NOT NULL,
        PRIMARY KEY (profile, package_id)
      )`,
    )
    ensure(
      this.#table,
      `CREATE TABLE IF NOT EXISTS composite_target_reverts (
        profile TEXT NOT NULL,
        failed_digest TEXT NOT NULL,
        target_digest TEXT NOT NULL,
        at TEXT NOT NULL,
        live INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (profile, failed_digest)
      )`,
    )
    this.#table.exec(`INSERT OR IGNORE INTO composite_targets (profile) VALUES (?)`, [profile])
  }

  publishDesired(
    artifact: RuntimeTargetArtifact,
    confirmation?: Readonly<{ generation: number; report: CompositeTargetReport }>,
    admission?: import('@agnes/protocol').PermissionEffectAdmission,
  ): void {
    const next = freezeArtifact(artifact)
    const report = confirmation ? this.#freezeReport(confirmation.report) : undefined
    this.#table.transaction(() => {
      const current = this.#row()
      admission?.assertActive()
      this.configAudit.commit(parseArtifact(current.desired_json)?.digest, next.digest)
      const previous = current.desired_json
      const acknowledged = parseJson<CompositeTargetAck>(current.acknowledged_json)
      const keepAck = acknowledged?.digest === next.digest
      this.#table.exec(
        `UPDATE composite_targets
         SET desired_json = ?, previous_json = ?, acknowledged_json = ?
         WHERE profile = ?`,
        [JSON.stringify(next), previous ?? null, keepAck ? current.acknowledged_json : null, this.#profile],
      )
      this.#retireRevertSuspicion()
      if (confirmation && report) {
        if (!this.#matchesDesired(confirmation.generation, next, next))
          throw new Error('E_RUNTIME_TARGET_OUTCOME_UNKNOWN')
        this.#writeQualification(confirmation.generation, next, report)
      }
      admission?.assertActive()
    })
    for (const listener of this.#desiredListeners) listener(next)
    if (report) for (const listener of this.#reportListeners) listener(report)
  }

  /** Home-wide live/rollback configuration references, including disabled plugin saved values. */
  credentialConfigurations(): {
    kind: 'plugin' | 'mcp'
    profile: string
    configId: string
    value: unknown
  }[] {
    const values: { kind: 'plugin' | 'mcp'; profile: string; configId: string; value: unknown }[] = []
    for (const row of this.#table.all<{
      profile: string
      desired_json: unknown
      previous_json: unknown
      last_good_json: unknown
    }>('SELECT profile, desired_json, previous_json, last_good_json FROM composite_targets')) {
      for (const raw of [row.desired_json, row.previous_json, row.last_good_json]) {
        const artifact = parseArtifact(raw)
        if (raw !== null && raw !== undefined && !artifact) throw unavailable()
        if (!artifact) continue
        const target = decodeRuntimeTargetArtifact(artifact)
        values.push({
          kind: 'mcp',
          profile: row.profile,
          configId: 'runtime-resources',
          value: target.resource.resources.mcp,
        })
        for (const item of [
          ...target.tree.rows,
          ...Object.values(target.resource.rows).flatMap((item) => (item ? [item] : [])),
        ])
          values.push({ kind: 'plugin', profile: row.profile, configId: item.id, value: item.config })
      }
    }
    for (const row of this.#table.all<{ profile: string; row_id: string; value_json: string }>(
      'SELECT profile, row_id, value_json FROM plugin_config_values',
    ))
      values.push({
        kind: 'plugin',
        profile: row.profile,
        configId: row.row_id,
        value: JSON.parse(row.value_json),
      })
    for (const row of this.#table.all<{ profile: string; value_json: string | null }>(
      'SELECT profile, value_json FROM plugin_config_intents',
    ))
      if (row.value_json) {
        const pending = JSON.parse(row.value_json) as { rowId: string; value: unknown }
        values.push({ kind: 'plugin', profile: row.profile, configId: pending.rowId, value: pending.value })
      }
    return values
  }

  desired(): RuntimeTargetArtifact | undefined {
    return this.#artifact(this.#row().desired_json)
  }

  previous(): RuntimeTargetArtifact | undefined {
    return this.#artifact(this.#row().previous_json)
  }

  lastGood(): RuntimeTargetArtifact | undefined {
    return this.#artifact(this.#row().last_good_json)
  }

  report(): CompositeTargetReport | undefined {
    return parseJson<CompositeTargetReport>(this.#row().report_json)
  }

  lastFailure(): CompositeTargetFailure | undefined {
    return parseJson<CompositeTargetFailure>(this.#row().last_failure_json)
  }

  acknowledged(): CompositeTargetAck | undefined {
    return parseJson<CompositeTargetAck>(this.#row().acknowledged_json)
  }

  /** Always read SQLite first. Only identical bytes reuse a bounded, deeply immutable validation. */
  #artifact(raw: unknown): RuntimeTargetArtifact | undefined {
    if (typeof raw !== 'string' || !raw) return undefined
    const prior = this.#artifacts.get(raw)
    if (prior) return prior
    const artifact = parseArtifact(raw)
    if (artifact) {
      if (this.#artifacts.size >= 3) this.#artifacts.clear()
      this.#artifacts.set(raw, artifact)
    }
    return artifact
  }

  /** Only immutable artifacts issued by this store may reuse their decoded projection. */
  target(artifact: RuntimeTargetArtifact): RuntimeTarget {
    const prior = this.#targets.get(artifact)
    if (prior) return prior
    const target = decodeRuntimeTargetArtifact(artifact)
    if ([...this.#artifacts.values()].includes(artifact)) this.#targets.set(artifact, target)
    return target
  }

  pending(workerGeneration?: number): boolean {
    const desired = this.desired()
    const ack = this.acknowledged()
    return Boolean(
      desired &&
        (desired.digest !== ack?.digest ||
          (workerGeneration !== undefined && ack?.generation !== workerGeneration)),
    )
  }

  qualifyConverged(
    generation: number,
    artifact: RuntimeTargetArtifact,
    report: CompositeTargetReport,
  ): boolean {
    const desired = this.desired()
    if (!this.#matchesDesired(generation, artifact, desired)) return false
    const frozenReport = this.#freezeReport(report)
    this.#table.transaction(() => this.#writeQualification(generation, desired, frozenReport))
    for (const listener of this.#reportListeners) listener(frozenReport)
    return true
  }

  #freezeReport(report: CompositeTargetReport): CompositeTargetReport {
    return Object.freeze({
      hash: report.hash,
      ok: report.ok,
      rows: Object.freeze(report.rows.map((row) => Object.freeze({ ...row }))),
    })
  }

  #writeQualification(
    generation: number,
    desired: RuntimeTargetArtifact,
    report: CompositeTargetReport,
  ): void {
    const ack = { digest: desired.digest, identity: desired.identity, generation }
    this.#table.exec(
      `UPDATE composite_targets
       SET last_good_json = ?, report_json = ?, acknowledged_json = ?, last_failure_json = NULL
       WHERE profile = ?`,
      [JSON.stringify(desired), JSON.stringify(report), JSON.stringify(ack), this.#profile],
    )
    this.#retireRevertSuspicion()
  }

  /**
   * Forget the last worker-confirmed target. A worker boots from it, so it must stop pointing at
   * package snapshots that no longer exist; boot then falls back to the current desired tree.
   */
  dropLastGood(): void {
    this.#table.exec(`UPDATE composite_targets SET last_good_json = NULL WHERE profile = ?`, [this.#profile])
  }

  /**
   * Revoke a package from all durable runtime targets. This is intentionally stronger than disable:
   * a restarted worker may boot from lastGood, and rollback may read previous, so all three targets
   * must lose the package before the disable reconciliation is allowed to proceed.
   */
  revokePackage(packageId: string): boolean {
    if (!packageId) throw new TypeError('packageId is required')
    let desired: RuntimeTargetArtifact | undefined
    let changed = false
    this.#table.transaction(() => {
      const current = this.#row()
      const sanitize = (value: unknown): string | null => {
        const artifact = parseArtifact(value)
        if (!artifact) return null
        const next = withoutPackageRows(artifact, packageId)
        if (next.digest !== artifact.digest) changed = true
        if (next.digest === artifact.digest) return JSON.stringify(artifact)
        if (value === current.desired_json) desired = next
        return JSON.stringify(next)
      }
      const nextDesired = sanitize(current.desired_json)
      const nextPrevious = sanitize(current.previous_json)
      const nextLastGood = sanitize(current.last_good_json)
      if (!changed) return
      this.#table.exec(
        `UPDATE composite_targets
         SET desired_json = ?, previous_json = ?, last_good_json = ?, acknowledged_json = NULL,
             report_json = NULL, last_failure_json = NULL
         WHERE profile = ?`,
        [nextDesired, nextPrevious, nextLastGood, this.#profile],
      )
      this.#table.exec(`DELETE FROM composite_target_package_failures WHERE profile = ? AND package_id = ?`, [
        this.#profile,
        packageId,
      ])
      this.#retireRevertSuspicion()
    })
    if (changed && desired) for (const listener of this.#desiredListeners) listener(desired)
    return changed
  }

  qualifyFailed(
    generation: number,
    artifact: RuntimeTargetArtifact,
    failure: CompositeTargetFailure,
  ): boolean {
    const desired = this.desired()
    if (!this.#matchesDesired(generation, artifact, desired)) return false
    if (
      failure.generation !== generation ||
      failure.digest !== artifact.digest ||
      failure.identity.treeHash !== artifact.identity.treeHash
    ) {
      return false
    }
    this.#table.transaction(() => {
      this.#table.exec(`UPDATE composite_targets SET last_failure_json = ? WHERE profile = ?`, [
        JSON.stringify(Object.freeze({ ...failure, identity: Object.freeze({ ...failure.identity }) })),
        this.#profile,
      ])
    })
    return true
  }

  /**
   * Replace a failed desired target with the one to fall back to, in one transaction. Nothing is
   * written when the desired target is no longer the one that failed. The worker's confirmation is
   * cleared, never forged: it has to confirm the target it is offered.
   */
  revertDesired(input: CompositeTargetRevert): boolean {
    const target = freezeArtifact(input.target)
    const applied = this.#table.transaction(() => {
      if (this.desired()?.digest !== input.expectedDigest) return false
      this.#table.exec(
        `UPDATE composite_targets
         SET desired_json = ?, acknowledged_json = NULL, last_failure_json = NULL
         WHERE profile = ?`,
        [JSON.stringify(target), this.#profile],
      )
      for (const packageId of input.packages) {
        const failure: CompositePackageFailure = Object.freeze({
          digest: input.failure.digest,
          phase: input.failure.phase,
          message: input.failure.message,
          at: input.at,
        })
        this.#table.exec(
          `INSERT INTO composite_target_package_failures (profile, package_id, failure_json)
           VALUES (?, ?, ?)
           ON CONFLICT(profile, package_id) DO UPDATE SET failure_json = excluded.failure_json`,
          [this.#profile, packageId, JSON.stringify(failure)],
        )
      }
      this.#table.exec(
        `INSERT OR REPLACE INTO composite_target_reverts (profile, failed_digest, target_digest, at, live)
         VALUES (?, ?, ?, ?, 1)`,
        [this.#profile, input.expectedDigest, target.digest, input.at],
      )
      return true
    })
    if (applied) for (const listener of this.#desiredListeners) listener(target)
    return applied
  }

  packageFailure(packageId: string): CompositePackageFailure | undefined {
    const row = this.#table.get<{ failure_json: unknown }>(
      `SELECT failure_json FROM composite_target_package_failures WHERE profile = ? AND package_id = ?`,
      [this.#profile, packageId],
    )
    return parseJson<CompositePackageFailure>(row?.failure_json)
  }

  clearPackageFailure(packageId: string): void {
    this.#table.exec(`DELETE FROM composite_target_package_failures WHERE profile = ? AND package_id = ?`, [
      this.#profile,
      packageId,
    ])
  }

  /** The target this failed digest was put back to, while that fallback is still unproven. */
  revertedFrom(failedDigest: string): Readonly<{ targetDigest: string }> | undefined {
    const row = this.#table.get<{ target_digest: string }>(
      `SELECT target_digest FROM composite_target_reverts WHERE profile = ? AND failed_digest = ? AND live = 1`,
      [this.#profile, failedDigest],
    )
    return row ? Object.freeze({ targetDigest: row.target_digest }) : undefined
  }

  /**
   * Whether this digest is where a failed target was put back to and nothing has been published or
   * confirmed since: the worker has not yet proved the fallback itself.
   */
  isRevertTarget(digest: string): boolean {
    return (
      this.#table.get(
        `SELECT 1 AS found FROM composite_target_reverts
         WHERE profile = ? AND target_digest = ? AND live = 1 LIMIT 1`,
        [this.#profile, digest],
      ) !== undefined
    )
  }

  pin(value: string): void {
    if (!value) throw new TypeError('pin is required')
    this.#table.exec(`INSERT OR IGNORE INTO composite_target_pins (profile, pin) VALUES (?, ?)`, [
      this.#profile,
      value,
    ])
  }

  pins(): readonly string[] {
    return Object.freeze(
      this.#table
        .all<{ pin: string }>(`SELECT pin FROM composite_target_pins WHERE profile = ? ORDER BY pin`, [
          this.#profile,
        ])
        .map((row) => row.pin),
    )
  }

  sweepPins(): void {
    this.#table.exec(`DELETE FROM composite_target_pins WHERE profile = ?`, [this.#profile])
  }

  onDesired(listener: (artifact: RuntimeTargetArtifact) => void): () => void {
    this.#desiredListeners.add(listener)
    return () => {
      this.#desiredListeners.delete(listener)
    }
  }

  onReport(listener: (report: CompositeTargetReport) => void): () => void {
    this.#reportListeners.add(listener)
    return () => {
      this.#reportListeners.delete(listener)
    }
  }

  #row(): StoreRow {
    const row = this.#table.get<StoreRow>(`SELECT * FROM composite_targets WHERE profile = ?`, [
      this.#profile,
    ])
    if (!row) throw unavailable()
    return row
  }

  /** A publish or a confirmation ends the doubt about a fallback target that has been offered. */
  #retireRevertSuspicion(): void {
    this.#table.exec(`UPDATE composite_target_reverts SET live = 0 WHERE profile = ?`, [this.#profile])
  }

  #matchesDesired(
    generation: number,
    artifact: RuntimeTargetArtifact,
    desired: RuntimeTargetArtifact | undefined,
  ): desired is RuntimeTargetArtifact {
    if (!Number.isSafeInteger(generation) || generation < 1 || !desired) return false
    const frozen = freezeArtifact(artifact)
    return (
      frozen.digest === desired.digest &&
      frozen.identity.treeHash === desired.identity.treeHash &&
      frozen.identity.resourceRevision === desired.identity.resourceRevision &&
      frozen.identity.compositeRevision === desired.identity.compositeRevision
    )
  }
}
