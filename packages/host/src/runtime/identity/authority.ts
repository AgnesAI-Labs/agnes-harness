import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { types } from 'node:util'
import type { CallContext } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  type AuthenticatedIdentity,
  type DataRef,
  type ScopeRef,
  type Timestamp,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { type IdentityCredentialSource, identityCredentialSource } from './source.js'
import type { VerifiedIdentityCredential } from './verify.js'

export type IdentityClaimsBinding = Readonly<{
  authorizationRef: string
  principalRef: string
  tenantRef: string
  bindingId: string
  scope: ScopeRef
  source: IdentityCredentialSource
}>

/** The trusted claims owner binds a real readable projection to this authentication instance. */
export interface IdentityClaimsOwner {
  create(binding: IdentityClaimsBinding, verified: VerifiedIdentityCredential): Promise<DataRef>
  validate(ref: DataRef, binding: IdentityClaimsBinding): boolean
}

export type CurrentIdentity = Readonly<{
  authorizationRef: string
  bindingId: string
  scope: ScopeRef
  identity: AuthenticatedIdentity
  source: IdentityCredentialSource
}>

export interface IdentityAuthority {
  accept(input: {
    verified: VerifiedIdentityCredential
    principalRef: string
    tenantRef: string
    bindingId: string
    scope: ScopeRef
    signal: AbortSignal
    source: IdentityCredentialSource
  }): Promise<CurrentIdentity | null>
  issue(
    authorizationRef: string,
    input: {
      bindingId: string
      scope: ScopeRef
      invocationId: string
      traceRef: string
      deadline: Timestamp
      signal: AbortSignal
    },
  ): CallContext | null
  current(context: CallContext): CurrentIdentity | null
  revoke(authorizationRef: string): boolean
  close(): void
}

export type IdentityCurrentFence = (staticCheck?: () => void) => boolean
/** Returns the original issuer's single final Clock value only after its native fence succeeds. */
export type IdentityCurrentAtFence = (staticCheck?: () => void) => number | null
type NativeIdentityCurrentFence = IdentityCurrentFence & { readonly checkAt: IdentityCurrentAtFence }

/** Host-private role proof; its final check never reads the issuer clock. */
export type IdentityRoleCurrentChecks = Readonly<{
  until: Timestamp
  dynamicCheck: () => void
  staticCheck: () => void
}>

const contextAuthorities = new WeakMap<CallContext, IdentityAuthority>()
const nativeAbortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get
const nativeObjectKeys = Object.keys
const nativeOwnKeys = Reflect.ownKeys
const nativeGetPrototypeOf = Object.getPrototypeOf
const nativeGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const nativeApply = Reflect.apply
const nativeIsFinite = Number.isFinite
function sameOwnDataDescriptors(
  expected: PropertyDescriptorMap,
  actual: PropertyDescriptorMap,
  keys: readonly (string | symbol)[],
): boolean {
  if (nativeOwnKeys(actual).length !== keys.length) return false
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    if (key === undefined) return false
    const before = expected[key as keyof typeof expected]
    const after = actual[key as keyof typeof actual]
    if (
      !before ||
      !after ||
      !('value' in after) ||
      after.value !== before.value ||
      after.writable !== before.writable ||
      after.enumerable !== before.enumerable ||
      after.configurable !== before.configurable
    )
      return false
  }
  return true
}
const commitFences = new WeakMap<
  IdentityAuthority,
  (context: CallContext, deadlineCeiling?: Timestamp) => NativeIdentityCurrentFence | null
>()
const jointCommitFences = new WeakMap<
  IdentityAuthority,
  (contexts: readonly [CallContext, CallContext], ceiling?: Timestamp) => NativeIdentityCurrentFence | null
>()

const roleCurrentChecks = new WeakMap<
  IdentityAuthority,
  (context: CallContext) => IdentityRoleCurrentChecks | null
>()
const authorityDatabases = new WeakMap<IdentityAuthority, DatabaseSync>()

/** Host-private proof that an original C14 issuer uses this exact native transaction domain. */
export function identityAuthorityUsesDatabase(authority: IdentityAuthority, database: DatabaseSync): boolean {
  return authorityDatabases.get(authority) === database
}

/** Keep the original role's dynamic work before the one financial issuer clock. */
export function captureIdentityRoleCurrentChecks(
  authority: IdentityAuthority,
  originalContext: CallContext,
): IdentityRoleCurrentChecks | null {
  return roleCurrentChecks.get(authority)?.(originalContext) ?? null
}

/** Private joint commit gate: one issuer clock, then both complete durable identity rows. */
export function captureIdentityCurrentFences(
  authority: IdentityAuthority,
  contexts: readonly [CallContext, CallContext],
  deadlineCeiling?: Timestamp,
): IdentityCurrentFence | null {
  const fence = jointCommitFences.get(authority)?.(contexts, deadlineCeiling)
  return fence ? (staticCheck) => fence(staticCheck) : null
}

/** Only authorities created here can fence a genuine issued context without running source callbacks. */
export function captureIdentityCurrentFence(
  authority: IdentityAuthority,
  context: CallContext,
  deadlineCeiling?: Timestamp,
): IdentityCurrentFence | null {
  const fence = commitFences.get(authority)?.(context, deadlineCeiling)
  return fence ? (staticCheck) => fence(staticCheck) : null
}

/** Private timestamped form of the same original C14 fence; callers must use it once per commit. */
export function captureIdentityCurrentAtFence(
  authority: IdentityAuthority,
  context: CallContext,
  deadlineCeiling?: Timestamp,
): IdentityCurrentAtFence | null {
  return commitFences.get(authority)?.(context, deadlineCeiling)?.checkAt ?? null
}

/** Capture the real issuer registered when this exact context was created. */
export function captureIdentityContextFence(context: CallContext): IdentityCurrentFence | null {
  const authority = contextAuthorities.get(context)
  return authority ? captureIdentityCurrentFence(authority, context) : null
}

/** Private current authorization authority. Every use reads the durable instance, never a principal cache. */
export function createIdentityAuthority(
  database: DatabaseSync,
  claims: IdentityClaimsOwner,
  now: () => number,
  authorizeBinding: (
    instance: CurrentIdentity,
    target: Readonly<{ bindingId: string; scope: ScopeRef }>,
  ) => boolean,
  sourceCurrent: (source: IdentityCredentialSource) => boolean,
): IdentityAuthority {
  database.exec(`CREATE TABLE IF NOT EXISTS runtime_identity_instances (
    authorization_ref TEXT PRIMARY KEY, principal_ref TEXT NOT NULL, tenant_ref TEXT NOT NULL,
    binding_id TEXT NOT NULL, scope_json TEXT NOT NULL, identity_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL, source_json TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
  )`)
  const jointIdentityStatement = database.prepare(
    'SELECT * FROM runtime_identity_instances WHERE authorization_ref = ?',
  )
  const readJointIdentityRow = jointIdentityStatement.get.bind(jointIdentityStatement)
  const contexts = new WeakMap<object, { authorizationRef: string; bindingId: string; scope: string }>()
  const verifiedRows = new WeakMap<CurrentIdentity, string>()
  const getContext = contexts.get.bind(contexts)
  const getContextAuthority = contextAuthorities.get.bind(contextAuthorities)
  let closed = false
  // The final gate reads durable state directly and never invokes a source or policy callback.
  function stillStored(instance: CurrentIdentity): boolean {
    if (closed) return false
    const expected = verifiedRows.get(instance)
    if (!expected) return false
    const row = database
      .prepare('SELECT * FROM runtime_identity_instances WHERE authorization_ref = ?')
      .get(instance.authorizationRef)
    return (
      row?.revoked === 0 &&
      jcs(row) === expected &&
      row.identity_json === jcs(instance.identity) &&
      row.scope_json === jcs(instance.scope) &&
      row.source_json === jcs(instance.source) &&
      row.binding_id === instance.bindingId
    )
  }
  function read(authorizationRef: string): CurrentIdentity | null {
    if (closed) return null
    try {
      const row = database
        .prepare('SELECT * FROM runtime_identity_instances WHERE authorization_ref = ?')
        .get(authorizationRef)
      if (row?.revoked !== 0 || typeof row.expires_at !== 'number' || row.expires_at <= now()) return null
      if (
        typeof row.identity_json !== 'string' ||
        typeof row.scope_json !== 'string' ||
        typeof row.binding_id !== 'string'
      )
        return null
      const identity = validateRuntime('AuthenticatedIdentity', JSON.parse(row.identity_json))
      const scope = validateRuntime('ScopeRef', JSON.parse(row.scope_json))
      const source =
        typeof row.source_json === 'string' ? identityCredentialSource(JSON.parse(row.source_json)) : null
      if (
        !identity.ok ||
        !scope.ok ||
        !source ||
        !sourceCurrent(source) ||
        identity.value.principalRef !== row.principal_ref ||
        identity.value.tenantRef !== row.tenant_ref ||
        Date.parse(identity.value.expiresAt) !== row.expires_at
      )
        return null
      const binding = {
        authorizationRef,
        principalRef: identity.value.principalRef,
        tenantRef: identity.value.tenantRef,
        bindingId: row.binding_id,
        scope: scope.value,
        source,
      }
      if (!claims.validate(identity.value.claims, binding)) return null
      const instance = Object.freeze({
        authorizationRef,
        bindingId: row.binding_id,
        scope: Object.freeze(scope.value),
        identity: Object.freeze(identity.value),
        source,
      })
      verifiedRows.set(instance, jcs(row))
      return stillStored(instance) ? instance : null
    } catch {
      return null
    }
  }
  const authority: IdentityAuthority = {
    async accept(input) {
      const source = identityCredentialSource(input.source)
      if (
        closed ||
        !source ||
        !sourceCurrent(source) ||
        input.signal.aborted ||
        input.verified.expiresAt <= now() ||
        !validateRuntime('ScopeRef', input.scope).ok
      )
        return null
      const authorizationRef = randomUUID()
      const scope = Object.freeze(JSON.parse(jcs(input.scope))) as ScopeRef
      const binding: IdentityClaimsBinding = Object.freeze({
        authorizationRef,
        principalRef: input.principalRef,
        tenantRef: input.tenantRef,
        bindingId: input.bindingId,
        scope,
        source,
      })
      const projection = await claims.create(binding, input.verified)
      if (
        closed ||
        !sourceCurrent(source) ||
        input.signal.aborted ||
        input.verified.expiresAt <= now() ||
        !claims.validate(projection, binding)
      )
        return null
      const identity = validateRuntime('AuthenticatedIdentity', {
        principalRef: input.principalRef,
        tenantRef: input.tenantRef,
        claims: projection,
        authRevision: 1,
        expiresAt: new Date(input.verified.expiresAt).toISOString(),
        authKind: input.verified.authKind,
        credentialKind: input.verified.credentialKind,
        ownerClass: input.verified.ownerClass,
      })
      if (!identity.ok) return null
      database
        .prepare(`INSERT INTO runtime_identity_instances
        (authorization_ref, principal_ref, tenant_ref, binding_id, scope_json, identity_json, expires_at, source_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          authorizationRef,
          input.principalRef,
          input.tenantRef,
          input.bindingId,
          jcs(scope),
          jcs(identity.value),
          input.verified.expiresAt,
          jcs(source),
        )
      return read(authorizationRef)
    },
    issue(authorizationRef, input) {
      const instance = read(authorizationRef)
      if (
        !instance ||
        input.signal.aborted ||
        !(Date.parse(input.deadline) > now()) ||
        !validateRuntime('ScopeRef', input.scope).ok ||
        !authorizeBinding(instance, input)
      )
        return null
      const scope = Object.freeze(JSON.parse(jcs(input.scope))) as ScopeRef
      const wire = validateRuntime('CallContextWire', {
        principalRef: instance.identity.principalRef,
        scope: instance.scope,
        bindingId: input.bindingId,
        invocationId: input.invocationId,
        traceRef: input.traceRef,
        deadline: new Date(
          Math.min(Date.parse(input.deadline), Date.parse(instance.identity.expiresAt)),
        ).toISOString(),
        authorizationRef,
      })
      if (!wire.ok) return null
      const context: CallContext = Object.freeze({ ...wire.value, scope, signal: input.signal })
      if (input.signal.aborted || !stillStored(instance)) return null
      contexts.set(context, { authorizationRef, bindingId: input.bindingId, scope: jcs(scope) })
      contextAuthorities.set(context, authority)
      return context
    },
    current(context) {
      const issued = contexts.get(context)
      if (!issued || context.signal.aborted || !(Date.parse(context.deadline) > now())) return null
      const instance = read(issued.authorizationRef)
      return instance &&
        context.authorizationRef === issued.authorizationRef &&
        context.principalRef === instance.identity.principalRef &&
        context.bindingId === issued.bindingId &&
        jcs(context.scope) === issued.scope &&
        authorizeBinding(instance, context) &&
        !context.signal.aborted &&
        stillStored(instance)
        ? instance
        : null
    },
    revoke(authorizationRef) {
      if (closed) return false
      return (
        database
          .prepare(
            'UPDATE runtime_identity_instances SET revoked = 1 WHERE authorization_ref = ? AND revoked = 0',
          )
          .run(authorizationRef).changes > 0
      )
    },
    close() {
      closed = true
    },
  }
  const originalCurrent = authority.current
  const captureNativeFence = (
    pair: readonly [CallContext] | readonly [CallContext, CallContext],
    deadlineCeiling?: Timestamp,
  ): NativeIdentityCurrentFence | null => {
    const ceilingAt = deadlineCeiling === undefined ? Number.POSITIVE_INFINITY : Date.parse(deadlineCeiling)
    if (types.isProxy(pair) || !Array.isArray(pair)) return null
    const first = Object.getOwnPropertyDescriptor(pair, '0')
    const second = Object.getOwnPropertyDescriptor(pair, '1')
    if (
      (pair.length !== 1 && pair.length !== 2) ||
      !first ||
      !('value' in first) ||
      (pair.length === 2 && (!second || !('value' in second) || first.value === second.value)) ||
      (deadlineCeiling !== undefined && !Number.isFinite(ceilingAt))
    )
      return null
    const capture = (context: CallContext) => {
      const instance = originalCurrent(context)
      const issued = contexts.get(context)
      if (!instance || !issued || contextAuthorities.get(context) !== authority) return null
      const signal = context.signal
      if (types.isProxy(signal)) return null
      try {
        if (!nativeAbortGetter || Reflect.apply(nativeAbortGetter, signal, []) !== false) return null
      } catch {
        return null
      }
      const signalDescriptors = nativeGetOwnPropertyDescriptors(signal)
      const signalKeys = nativeOwnKeys(signalDescriptors)
      if (
        Object.hasOwn(signalDescriptors, 'aborted') ||
        signalKeys.some((key) => {
          const descriptor = signalDescriptors[key as keyof typeof signalDescriptors]
          return !descriptor || !('value' in descriptor)
        })
      )
        return null
      const row = readJointIdentityRow(instance.authorizationRef)
      if (!row || jcs(row) !== verifiedRows.get(instance)) return null
      return {
        context,
        instance,
        issued,
        row,
        keys: nativeObjectKeys(row),
        scope: context.scope,
        signal,
        signalDescriptors,
        signalKeys,
        signalPrototype: nativeGetPrototypeOf(signal),
        deadline: context.deadline,
        deadlineAt: Date.parse(context.deadline),
        expiresAt: Date.parse(instance.identity.expiresAt),
      }
    }
    const left = capture(first.value)
    const right = pair.length === 2 ? capture(second?.value) : undefined
    if (!left || (pair.length === 2 && !right)) return null
    const retained = right ? [left, right] : [left]
    const checkAt: IdentityCurrentAtFence = (staticCheck) => {
      // Any dynamic source or policy work must already have run before this gate.
      const at = now()
      staticCheck?.()
      if (closed || !nativeIsFinite(at) || at >= ceilingAt) return null
      for (let retainedIndex = 0; retainedIndex < retained.length; retainedIndex++) {
        const entry = retained[retainedIndex]
        if (!entry) return null
        const { context, instance, issued, row, keys } = entry
        if (
          context.signal !== entry.signal ||
          nativeGetPrototypeOf(entry.signal) !== entry.signalPrototype ||
          context.scope !== entry.scope ||
          context.deadline !== entry.deadline ||
          !(at < entry.deadlineAt && at < entry.expiresAt) ||
          getContext(context) !== issued ||
          getContextAuthority(context) !== authority ||
          context.authorizationRef !== issued.authorizationRef ||
          context.principalRef !== instance.identity.principalRef ||
          context.bindingId !== issued.bindingId
        )
          return null
        const actualSignal = nativeGetOwnPropertyDescriptors(entry.signal)
        if (!sameOwnDataDescriptors(entry.signalDescriptors, actualSignal, entry.signalKeys)) return null
        const current = readJointIdentityRow(instance.authorizationRef)
        if (current?.revoked !== 0 || nativeObjectKeys(current).length !== keys.length) return null
        for (let index = 0; index < keys.length; index++) {
          const key = keys[index]
          if (key === undefined || current[key] !== row[key]) return null
        }
      }
      return at
    }
    return Object.assign((staticCheck?: () => void) => checkAt(staticCheck) !== null, { checkAt })
  }
  roleCurrentChecks.set(authority, (context) => {
    const instance = originalCurrent(context)
    const issued = contexts.get(context)
    if (!instance || !issued || contextAuthorities.get(context) !== authority) return null
    const signal = context.signal
    if (types.isProxy(signal)) return null
    try {
      if (!nativeAbortGetter || Reflect.apply(nativeAbortGetter, signal, []) !== false) return null
    } catch {
      return null
    }
    const descriptors = Object.getOwnPropertyDescriptors(signal)
    const keys = Reflect.ownKeys(descriptors)
    if (
      Object.hasOwn(descriptors, 'aborted') ||
      keys.some((key) => {
        const descriptor = descriptors[key as keyof typeof descriptors]
        return !descriptor || !('value' in descriptor)
      })
    )
      return null
    const signalPrototype = Object.getPrototypeOf(signal)
    const scope = context.scope
    const deadline = context.deadline
    const deadlineAt = Date.parse(deadline)
    const expiresAt = Date.parse(instance.identity.expiresAt)
    if (!Number.isFinite(deadlineAt) || !Number.isFinite(expiresAt)) return null
    const staticCheck = () => {
      if (
        closed ||
        contexts.get(context) !== issued ||
        contextAuthorities.get(context) !== authority ||
        context.signal !== signal ||
        context.scope !== scope ||
        context.deadline !== deadline ||
        context.authorizationRef !== issued.authorizationRef ||
        context.principalRef !== instance.identity.principalRef ||
        context.bindingId !== issued.bindingId ||
        nativeGetPrototypeOf(signal) !== signalPrototype ||
        !nativeAbortGetter ||
        nativeApply(nativeAbortGetter, signal, []) !== false ||
        !stillStored(instance)
      )
        throw new Error('Original role authorization changed')
      const actual = nativeGetOwnPropertyDescriptors(signal)
      if (!sameOwnDataDescriptors(descriptors, actual, keys)) throw new Error('Original role signal changed')
    }
    return {
      until: deadlineAt <= expiresAt ? deadline : instance.identity.expiresAt,
      dynamicCheck() {
        const current = originalCurrent(context)
        if (!current || jcs(current) !== jcs(instance)) throw new Error('Original role is not current')
      },
      staticCheck,
    }
  })
  commitFences.set(authority, (context, ceiling) => captureNativeFence([context], ceiling))
  jointCommitFences.set(authority, (pair, ceiling) => {
    if (types.isProxy(pair) || !Array.isArray(pair) || pair.length !== 2) return null
    return captureNativeFence(pair, ceiling)
  })
  authorityDatabases.set(authority, database)
  return authority
}
