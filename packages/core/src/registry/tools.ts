import { checkToolDef, type ToolDef, type ToolMeta } from '@agnes/extension-api'
import { canonicalJson, sha256Hex } from '../request/hash.js'
import { CoreError, type Disposer, type Seq } from '../types.js'
import { OwnedRegistryTable } from './owner-batch.js'

export type TrustTier = 'builtin' | 'trusted'
export type ExecutionDomain = 'workspace' | 'host-computer-use'
export type ToolSource = {
  source: string
  trust: TrustTier
  /** Host-attested package identity and manifest version; never copied from classifier output. */
  packageIdentity?: string
  packageVersion?: string
  /** Only Host assembly may request this, and the registry still verifies the exact built-in pair. */
  executionDomain?: ExecutionDomain
  /**
   * Fixed dispatch position among the built-in hook layer (third-party-transform-directive-hooks
   * design §3). Only Host assembly may set this, and only for a registration it has attested as
   * `trust: 'builtin'` (or a plugin row that legitimately replaced one) — a plugin can never reach
   * this field itself. Unset means the third-party layer: registered after every ranked entry, in
   * registration order. Meaningless for tool registrations; only `HookRegistry` reads it.
   */
  hookRank?: number
}
export type RegisteredTool = ToolDef & {
  source: ToolSource
  packageIdentity?: string
  packageVersion?: string
  executionDomain: ExecutionDomain
  definitionFingerprint: string
}
export type RegistrySnapshot = {
  readonly defs: ReadonlyArray<ToolDef>
  readonly byName: ReadonlyMap<string, RegisteredTool>
  readonly hash: string
  readonly takenAtSeq: Seq
}

/**
 * The tools one assembled session can call, and the frozen view of that table a request is derived
 * against. The table is live — an extension may register and dispose while a session runs — so a
 * request records the snapshot it was built from rather than reading the table twice.
 */
export class ToolRegistry {
  readonly #table = new OwnedRegistryTable<RegisteredTool>(true)

  get size(): number {
    return this.#table.size
  }

  add(def: ToolDef, meta: ToolSource): Disposer {
    // Materialize the two caller-owned records exactly once. Accessor-backed definitions and Host
    // metadata must not be able to answer validation, fingerprinting and ownership with different
    // values during one registration.
    const input = { ...def } as ToolDef
    const registeredSource = Object.freeze({ ...meta }) as ToolSource
    const materializedMeta = materializeToolMeta(input.meta)
    const candidateDefinition: ToolDef = {
      ...input,
      parameters: cloneFrozenSchema(input.parameters),
      meta: materializedMeta as ToolMeta,
    }
    // The author-facing package owns what "well formed" means: the name grammar, all eight meta
    // keys present, the replay and requiresApproval enums, the per-key costHint shape and the four
    // booleans. Re-stating any of it here would let a tool that fails the author-facing check still
    // register in the kernel, and the two gates would drift apart one key at a time.
    const check = checkToolDef(candidateDefinition)
    const name = (candidateDefinition as { name?: unknown }).name
    if (!check.ok)
      throw new CoreError('E_TOOLDEF_META', `${String(name)}: ${check.problems.join('; ')}`, {
        name,
        problems: check.problems,
      })
    const registeredDefinition: ToolDef = {
      ...candidateDefinition,
      meta: snapshotToolMeta(candidateDefinition.meta),
    }
    const executionDomain = attestExecutionDomain(registeredSource)
    const definitionFingerprint = fingerprintToolDefinition(registeredDefinition, registeredSource)
    if (this.#table.get(registeredDefinition.name))
      throw new CoreError('E_REGISTRY_DUPLICATE', registeredDefinition.name)
    const entry: RegisteredTool = Object.freeze({
      ...registeredDefinition,
      // Keep the long-standing public source shape stable. Package provenance is separate
      // attestation data and must not leak into hook/resource registrations that share ToolSource.
      source: Object.freeze({ source: registeredSource.source, trust: registeredSource.trust }),
      ...(registeredSource.packageIdentity === undefined
        ? {}
        : { packageIdentity: registeredSource.packageIdentity }),
      ...(registeredSource.packageVersion === undefined
        ? {}
        : { packageVersion: registeredSource.packageVersion }),
      executionDomain,
      definitionFingerprint,
    })
    return this.#table.add(registeredSource.source, registeredDefinition.name, entry)
  }

  prepareOwnerReplacement(owner: string, candidate: ToolRegistry) {
    return this.#table.prepare(owner, candidate.#table)
  }

  registrations(owner: string): string[] {
    return this.#table
      .values()
      .filter((entry) => entry.source.source === owner)
      .map((entry) => `tool:${entry.name}`)
  }

  resolve(name: string): RegisteredTool | undefined {
    return this.#table.get(name)
  }

  list(filter: { trust?: TrustTier; names?: Iterable<string>; deferred?: boolean } = {}): ToolDef[] {
    const names = filter.names ? new Set(filter.names) : undefined
    return [...this.#table.values()].filter(
      (d) =>
        (filter.trust === undefined || d.source.trust === filter.trust) &&
        (!names || names.has(d.name)) &&
        (filter.deferred === undefined || (d.meta.deferLoading === true) === filter.deferred),
    )
  }

  /**
   * The table as of one seq. Sorted by name so the hash does not depend on registration order, and
   * hashed over names and parameter schemas — the two things a model actually sees, and therefore
   * the two whose change makes a cached prefix no longer describe the tools on offer.
   */
  snapshot(seq: Seq): RegistrySnapshot {
    const defs = Object.freeze([...this.#table.values()].sort((a, b) => a.name.localeCompare(b.name)))
    const byName = new Map(defs.map((d) => [d.name, d]))
    const hash = sha256Hex(canonicalJson(defs.map((d) => ({ name: d.name, parameters: d.parameters }))))
    // Shallow on purpose: the snapshot and its list are immutable, while the ToolDef objects inside
    // still belong to whoever registered them — freezing those would change an object the caller is
    // still holding.
    return Object.freeze({ defs, byName, hash, takenAtSeq: seq })
  }
}

function materializeToolMeta(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const materialized = { ...(value as Record<string, unknown>) }
  if (
    Object.hasOwn(materialized, 'costHint') &&
    materialized.costHint !== null &&
    typeof materialized.costHint === 'object' &&
    !Array.isArray(materialized.costHint)
  )
    materialized.costHint = { ...(materialized.costHint as Record<string, unknown>) }
  return materialized
}

function snapshotToolMeta(meta: ToolMeta): ToolMeta {
  const costHint = meta.costHint === undefined ? undefined : Object.freeze({ ...meta.costHint })
  return Object.freeze({
    isReadOnly: meta.isReadOnly,
    isDestructive: meta.isDestructive,
    isConcurrencySafe: meta.isConcurrencySafe,
    isOpenWorld: meta.isOpenWorld,
    replay: meta.replay,
    costHint,
    deferLoading: meta.deferLoading,
    requiresApproval: meta.requiresApproval,
  })
}

/**
 * TypeBox schemas carry symbol keys, so structuredClone would silently drop part of the schema.
 * Copy every own property descriptor, including symbols, and freeze only the registry-owned copy.
 */
function cloneFrozenSchema<T>(value: T, seen = new WeakMap<object, object>()): T {
  if (value === null || typeof value !== 'object') return value
  const source = value as object
  const prior = seen.get(source)
  if (prior) return prior as T
  const array = Array.isArray(source)
  const prototype = Object.getPrototypeOf(source)
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    throw new CoreError('E_TOOLDEF_META', 'tool parameter schema must contain only plain data')
  const clone: object = array ? [] : Object.create(prototype)
  seen.set(source, clone)
  for (const key of Reflect.ownKeys(source)) {
    if (array && key === 'length') continue
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (!descriptor) continue
    if (!('value' in descriptor))
      throw new CoreError('E_TOOLDEF_META', 'tool parameter schema must contain only plain data')
    Object.defineProperty(clone, key, {
      value: cloneFrozenSchema(descriptor.value, seen),
      enumerable: descriptor.enumerable === true,
      configurable: true,
      writable: true,
    })
  }
  if (array) (clone as unknown[]).length = (source as unknown[]).length
  return Object.freeze(clone) as T
}

const COMPUTER_USE_PACKAGE = '@agnes/base'
const COMPUTER_USE_EXTENSION = 'agnes/computer-use'
const IDENTITY_LIMIT = 256
const VERSION_LIMIT = 128

function presentString(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
}

function attestExecutionDomain(meta: ToolSource): ExecutionDomain {
  const domain = meta.executionDomain ?? 'workspace'
  if (domain !== 'workspace' && domain !== 'host-computer-use')
    throw new CoreError('E_TOOLDEF_META', 'invalid execution domain')
  if (
    domain === 'host-computer-use' &&
    !(
      meta.trust === 'builtin' &&
      meta.packageIdentity === COMPUTER_USE_PACKAGE &&
      meta.source === COMPUTER_USE_EXTENSION &&
      presentString(meta.packageVersion, VERSION_LIMIT)
    )
  )
    throw new CoreError('E_TOOLDEF_META', 'host-computer-use requires exact built-in package attestation', {
      source: meta.source,
      trust: meta.trust,
      packageIdentity: meta.packageIdentity,
    })
  return domain
}

function fingerprintToolDefinition(def: ToolDef, meta: ToolSource): string {
  if (def.classify) {
    if (
      !presentString(meta.packageIdentity, IDENTITY_LIMIT) ||
      !presentString(meta.packageVersion, VERSION_LIMIT)
    )
      throw new CoreError(
        'E_TOOLDEF_META',
        'classified tools require Host-attested package identity and version',
        {
          name: def.name,
          source: meta.source,
        },
      )
    return sha256Hex(
      canonicalJson({
        packageIdentity: meta.packageIdentity,
        packageVersion: meta.packageVersion,
        name: def.name,
        parametersHash: sha256Hex(canonicalJson(def.parameters)),
        policyVersion: def.policyVersion,
        isConcurrencySafe: def.meta.isConcurrencySafe,
        isOpenWorld: def.meta.isOpenWorld,
      }),
    )
  }
  // Legacy static tools have no author-managed policyVersion. Include precisely the safety fields
  // that are converted into their persisted call policy so a change parks an old open call.
  return sha256Hex(
    canonicalJson({
      packageIdentity: meta.packageIdentity ?? meta.source,
      packageVersion: meta.packageVersion ?? 'legacy',
      name: def.name,
      parametersHash: sha256Hex(canonicalJson(def.parameters)),
      policyVersion: 'static-v1',
      policy: {
        isReadOnly: def.meta.isReadOnly,
        isDestructive: def.meta.isDestructive,
        isConcurrencySafe: def.meta.isConcurrencySafe,
        isOpenWorld: def.meta.isOpenWorld,
        replay: def.meta.replay,
        requiresApproval: def.meta.requiresApproval ?? (def.meta.isDestructive ? 'destructive' : 'never'),
        approvalScopes: [],
      },
    }),
  )
}
