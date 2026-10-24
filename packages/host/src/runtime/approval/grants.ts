import { type ApprovalGrantQuery, type ApprovalGrantsPort, canonicalJson } from '@agnes/core'
import type { PersistenceMetadataNamespace } from '@agnes/extension-api'
import { type ApprovalGrant, isDateTime, validateActor } from '@agnes/protocol'

const POLICY_DIGEST = /^sha256-[a-f0-9]{64}$/
const STORE_VERSION = 3
const BINDING_KEYS = new Set(['policyDigest', 'actorId', 'actorOrg', 'toolId', 'scope', 'policyVersion'])
const GRANT_KEYS = new Set([
  'grantId',
  'policyDigest',
  'actorId',
  'actorOrg',
  'toolId',
  'scope',
  'policyVersion',
  'createdAt',
  'sourceDecisionId',
  'issuer',
  'definitionFingerprint',
  'policyBinding',
  'revokedAt',
])
const REQUIRED_GRANT_KEYS = [...GRANT_KEYS].filter((key) => key !== 'revokedAt')
export type ApprovalGrantBinding = ApprovalGrantQuery

/** Safe management surface. Grant activation remains private to the Core seam adapter below. */
/** Whose grants, under which policy: everything a grant is bound to except the tool it names. */
export type ApprovalGrantHolder = Pick<ApprovalGrantBinding, 'policyDigest' | 'actorId' | 'actorOrg'>

export interface ApprovalGrantStore {
  list(binding: ApprovalGrantBinding): ApprovalGrant[]
  /** Every active grant one actor holds under one policy, so a client need not probe tool by tool. */
  listHolder(holder: ApprovalGrantHolder): ApprovalGrant[]
  /** Authenticated management path: every security binding is required and matched before revoke. */
  revoke(binding: ApprovalGrantBinding, grantId: string, revokedAt: string): ApprovalGrant | null
}

export interface ApprovalGrantManagement extends ApprovalGrantStore {
  /** In-process invalidation fan-out. Durable readers still re-check durable storage on every authorization. */
  onRevoked(listener: (grant: ApprovalGrant) => void): () => void
}

export type ApprovalGrantControlPlane = Readonly<{
  management: ApprovalGrantManagement
  /** What Core reads and writes permanent grants through. */
  port: ApprovalGrantsPort
}>

type ApprovalGrantRuntimeStore = ApprovalGrantStore & {
  /** Activates only the grant identity already persisted by Core's approval ledger. */
  put(grant: ApprovalGrant): void
  /** Core-private compatibility path; deliberately absent from ApprovalGrantStore and Host exports. */
  revokeById(grantId: string, revokedAt: string): ApprovalGrant | null
  revokeBound(
    binding: ApprovalGrantBinding,
    grantId: string,
    revokedAt: string,
  ): { grant: ApprovalGrant | null; changed: boolean }
  revokeByIdWithState(grantId: string, revokedAt: string): { grant: ApprovalGrant | null; changed: boolean }
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\u0000'))
    throw new TypeError(`invalid approval grant ${field}`)
  return value
}

function instant(value: unknown, field: string): string {
  const result = text(value, field, 64)
  // This is the generated Protocol date-time rule, including real month/leap-day bounds. Date.parse
  // alone normalizes impossible dates such as 2026-02-30 and would silently accept a different day.
  if (!isDateTime(result)) throw new TypeError(`invalid approval grant ${field}`)
  return result
}

function binding(input: unknown): ApprovalGrantBinding {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError('invalid approval grant binding object')
  const ownKeys = Reflect.ownKeys(input)
  if (
    ownKeys.some((key) => typeof key !== 'string' || !BINDING_KEYS.has(key)) ||
    [...BINDING_KEYS].some((key) => !Object.hasOwn(input, key))
  )
    throw new TypeError('invalid approval grant binding fields')
  const value = input as Record<string, unknown>
  const policyDigest = text(value.policyDigest, 'policyDigest', 71)
  if (!POLICY_DIGEST.test(policyDigest)) throw new TypeError('invalid approval grant policyDigest')
  return {
    policyDigest,
    actorId: text(value.actorId, 'actorId', 256),
    actorOrg: text(value.actorOrg, 'actorOrg', 256),
    toolId: text(value.toolId, 'toolId', 128),
    scope: text(value.scope, 'scope', 256),
    policyVersion: text(value.policyVersion, 'policyVersion', 64),
  }
}

function holder(input: ApprovalGrantHolder): ApprovalGrantHolder {
  const policyDigest = text(input.policyDigest, 'policyDigest', 71)
  if (!POLICY_DIGEST.test(policyDigest)) throw new TypeError('invalid approval grant policyDigest')
  return {
    policyDigest,
    actorId: text(input.actorId, 'actorId', 256),
    actorOrg: text(input.actorOrg, 'actorOrg', 256),
  }
}

function checked(input: unknown): ApprovalGrant {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError('invalid approval grant object')
  const ownKeys = Reflect.ownKeys(input)
  if (
    ownKeys.some((key) => typeof key !== 'string' || !GRANT_KEYS.has(key)) ||
    REQUIRED_GRANT_KEYS.some((key) => !Object.hasOwn(input, key))
  )
    throw new TypeError('invalid approval grant fields')
  const grant = input as Record<string, unknown>
  const grantId = text(grant.grantId, 'grantId', 128)
  const bound = binding({
    policyDigest: grant.policyDigest,
    actorId: grant.actorId,
    actorOrg: grant.actorOrg,
    toolId: grant.toolId,
    scope: grant.scope,
    policyVersion: grant.policyVersion,
  })
  if (!validateActor(grant.issuer).ok || (grant.issuer as ApprovalGrant['issuer']).role === 'agent')
    throw new TypeError('invalid approval grant issuer')
  for (const field of ['definitionFingerprint', 'policyBinding'] as const)
    if (typeof grant[field] !== 'string' || !/^[0-9a-f]{64}$/.test(grant[field]))
      throw new TypeError(`invalid approval grant ${field}`)
  const hasRevokedAt = Object.hasOwn(grant, 'revokedAt')
  return {
    grantId,
    ...bound,
    createdAt: instant(grant.createdAt, 'createdAt'),
    sourceDecisionId: text(grant.sourceDecisionId, 'sourceDecisionId', 256),
    issuer: structuredClone(grant.issuer) as ApprovalGrant['issuer'],
    definitionFingerprint: grant.definitionFingerprint as string,
    policyBinding: grant.policyBinding as string,
    ...(hasRevokedAt ? { revokedAt: instant(grant.revokedAt, 'revokedAt') } : {}),
  }
}

const sameGrant = (left: ApprovalGrant, right: ApprovalGrant): boolean =>
  left.grantId === right.grantId &&
  left.policyDigest === right.policyDigest &&
  left.actorId === right.actorId &&
  left.actorOrg === right.actorOrg &&
  left.toolId === right.toolId &&
  left.scope === right.scope &&
  left.policyVersion === right.policyVersion &&
  left.createdAt === right.createdAt &&
  left.sourceDecisionId === right.sourceDecisionId &&
  canonicalJson(left.issuer) === canonicalJson(right.issuer) &&
  left.definitionFingerprint === right.definitionFingerprint &&
  left.policyBinding === right.policyBinding &&
  left.revokedAt === right.revokedAt

const matches = (grant: ApprovalGrant, query: ApprovalGrantBinding): boolean =>
  grant.policyDigest === query.policyDigest &&
  grant.actorId === query.actorId &&
  grant.actorOrg === query.actorOrg &&
  grant.toolId === query.toolId &&
  grant.scope === query.scope &&
  grant.policyVersion === query.policyVersion

function createApprovalGrantRuntimeStore(ns: PersistenceMetadataNamespace): ApprovalGrantRuntimeStore {
  const initialize = (): void => {
    const version = ns.get('version')
    if (version !== undefined && version !== STORE_VERSION)
      throw new Error('reset-required: E_APPROVAL_GRANT_SCHEMA_VERSION: incompatible metadata version')
    if (version === undefined && ns.entries().length)
      throw new Error('reset-required: unversioned approval grant metadata')
    for (const { key, value } of ns.entries()) {
      if (key === 'version') continue
      const grant = checked(value)
      if (key !== `grant:${grant.grantId}`) throw new Error('reset-required: invalid metadata grant identity')
    }
    if (version === undefined) ns.set('version', STORE_VERSION)
  }
  const transaction = <T>(fn: () => T): T =>
    ns.transaction(() => {
      initialize()
      return fn()
    })
  const read = (id: string): ApprovalGrant | undefined => {
    const value = ns.get(`grant:${id}`)
    return value === undefined ? undefined : checked(value)
  }
  const revoke = (id: string, at: string, query?: ApprovalGrantBinding) =>
    transaction(() => {
      const grant = read(id)
      if (!grant || (query && !matches(grant, query))) return { grant: null, changed: false }
      if (grant.revokedAt !== undefined) return { grant, changed: false }
      const revoked = { ...grant, revokedAt: at }
      ns.set(`grant:${id}`, revoked)
      return { grant: revoked, changed: true }
    })
  return {
    list(input) {
      const query = binding(input)
      return transaction(() =>
        ns
          .entries()
          .filter(({ key }) => key.startsWith('grant:'))
          .map(({ value }) => checked(value))
          .filter((grant) => grant.revokedAt === undefined && matches(grant, query))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.grantId.localeCompare(b.grantId)),
      )
    },
    listHolder(input) {
      const query = holder(input)
      return transaction(() =>
        ns
          .entries()
          .filter(({ key }) => key.startsWith('grant:'))
          .map(({ value }) => checked(value))
          .filter(
            (grant) =>
              grant.revokedAt === undefined &&
              grant.policyDigest === query.policyDigest &&
              grant.actorId === query.actorId &&
              grant.actorOrg === query.actorOrg,
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.grantId.localeCompare(b.grantId)),
      )
    },
    put(input) {
      const grant = checked(input)
      if (grant.revokedAt !== undefined)
        throw new TypeError('cannot insert an already revoked approval grant')
      transaction(() => {
        const prior = read(grant.grantId)
        if (prior && !sameGrant(prior, grant)) throw new Error('approval grant id collision')
        if (!prior) ns.set(`grant:${grant.grantId}`, grant)
      })
    },
    revokeBound(input, grantId, revokedAt) {
      return revoke(text(grantId, 'grantId', 128), instant(revokedAt, 'revokedAt'), binding(input))
    },
    revoke(input, grantId, revokedAt) {
      return revoke(text(grantId, 'grantId', 128), instant(revokedAt, 'revokedAt'), binding(input)).grant
    },
    revokeByIdWithState(grantId, revokedAt) {
      return revoke(text(grantId, 'grantId', 128), instant(revokedAt, 'revokedAt'))
    },
    revokeById(grantId, revokedAt) {
      return revoke(text(grantId, 'grantId', 128), instant(revokedAt, 'revokedAt')).grant
    },
  }
}

/** Opens only the fully-bound management surface; activation and id-only revoke stay in Host/Core. */
export function createApprovalGrantStore(ns: PersistenceMetadataNamespace): ApprovalGrantStore {
  const backend = createApprovalGrantRuntimeStore(ns)
  return Object.freeze({ list: backend.list, listHolder: backend.listHolder, revoke: backend.revoke })
}

export function createApprovalGrantControlPlane(
  ns: PersistenceMetadataNamespace,
  bindTicket?: (grantId: string) => void,
): ApprovalGrantControlPlane {
  const store = createApprovalGrantRuntimeStore(ns)
  const listeners = new Set<(grant: ApprovalGrant) => void>()
  const emit = (grant: ApprovalGrant): void => {
    // Revocation is already durable. A broken observer cannot roll it back or prevent the remaining
    // active-session/cache listeners from seeing the invalidation. Snapshotting also makes one
    // durable transition exactly-once for the listeners present at emit start: a callback may
    // unsubscribe/re-subscribe without being visited again by the live Set iterator.
    for (const listener of [...listeners])
      try {
        listener(structuredClone(grant))
      } catch {
        // A failed observer cannot undo durable revocation.
      }
  }
  const management: ApprovalGrantManagement = Object.freeze({
    list: store.list,
    listHolder: store.listHolder,
    revoke(input: ApprovalGrantBinding, grantId: string, revokedAt: string) {
      const result = store.revokeBound(input, grantId, revokedAt)
      if (result.changed && result.grant) emit(result.grant)
      return result.grant
    },
    onRevoked(listener: (grant: ApprovalGrant) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })
  // Permanent grants are not cached today: every authorization reads durable storage. Revocation
  // emits through `management.onRevoked`, the explicit invalidation port for any future cache.
  const port: ApprovalGrantsPort = Object.freeze({
    list: async (query: ApprovalGrantQuery) => store.list(query),
    put: async (grant: ApprovalGrant) => {
      bindTicket?.(grant.grantId)
      store.put(grant)
    },
  })
  return Object.freeze({ management, port })
}
