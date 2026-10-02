import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { CallContext } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  type AuthenticatedIdentity,
  type DataRef,
  type ScopeRef,
  type Timestamp,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { ReferenceCredential } from './verify.js'

export type ReferenceIdentitySource = Readonly<
  | { kind: 'deployment'; generation: string; keyId: string | null }
  | { kind: 'http-session'; ownerRef: string; revision: number }
>
type ClaimsBinding = Readonly<{
  authorizationRef: string
  principalRef: string
  tenantRef: string
  bindingId: string
  scope: ScopeRef
  source: ReferenceIdentitySource
}>
export type ReferenceCurrentIdentity = Readonly<{
  authorizationRef: string
  bindingId: string
  scope: ScopeRef
  identity: AuthenticatedIdentity
  source: ReferenceIdentitySource
}>
export interface ReferenceIdentityAuthority {
  accept(input: {
    verified: ReferenceCredential
    principalRef: string
    tenantRef: string
    bindingId: string
    scope: ScopeRef
    signal: AbortSignal
    source: ReferenceIdentitySource
  }): Promise<ReferenceCurrentIdentity | null>
  issue(
    ref: string,
    input: {
      bindingId: string
      scope: ScopeRef
      invocationId: string
      traceRef: string
      deadline: Timestamp
      signal: AbortSignal
    },
  ): CallContext | null
  current(context: CallContext): ReferenceCurrentIdentity | null
  revoke(ref: string): boolean
  close(): void
}

/** Independent reference instance journal; it does not import the default current authorization owner. */
export function createReferenceIdentityAuthority(
  database: DatabaseSync,
  ports: {
    now(): number
    claims: {
      create(binding: ClaimsBinding, verified: ReferenceCredential): Promise<DataRef>
      validate(ref: DataRef, binding: ClaimsBinding): boolean
    }
    authorize(
      instance: ReferenceCurrentIdentity,
      target: Readonly<{ bindingId: string; scope: ScopeRef }>,
    ): boolean
    sourceCurrent(source: ReferenceIdentitySource): boolean
  },
): ReferenceIdentityAuthority {
  database.exec(
    'CREATE TABLE IF NOT EXISTS reference_identity (id TEXT PRIMARY KEY,record TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0)',
  )
  let disposed = false
  const contexts = new WeakSet<object>()
  function resolve(id: string): ReferenceCurrentIdentity | null {
    if (disposed) return null
    try {
      const row = database
        .prepare('SELECT record FROM reference_identity WHERE id = ? AND revoked = 0')
        .get(id)
      if (typeof row?.record !== 'string') return null
      const parsed: unknown = JSON.parse(row.record)
      if (!parsed || typeof parsed !== 'object') return null
      const record = parsed as ReferenceCurrentIdentity
      const identity = validateRuntime('AuthenticatedIdentity', record.identity)
      const scope = validateRuntime('ScopeRef', record.scope)
      if (
        !identity.ok ||
        !scope.ok ||
        !record.source ||
        !ports.sourceCurrent(record.source) ||
        record.authorizationRef !== id ||
        typeof record.bindingId !== 'string' ||
        Date.parse(identity.value.expiresAt) <= ports.now()
      )
        return null
      if (
        !ports.claims.validate(identity.value.claims, {
          authorizationRef: id,
          bindingId: record.bindingId,
          scope: scope.value,
          principalRef: identity.value.principalRef,
          tenantRef: identity.value.tenantRef,
          source: record.source,
        })
      )
        return null
      return Object.freeze({
        authorizationRef: id,
        bindingId: record.bindingId,
        scope: Object.freeze(scope.value),
        identity: Object.freeze(identity.value),
        source: Object.freeze(record.source),
      })
    } catch {
      return null
    }
  }
  return {
    async accept(input) {
      if (
        disposed ||
        !ports.sourceCurrent(input.source) ||
        input.signal.aborted ||
        input.verified.expiresAt <= ports.now() ||
        !validateRuntime('ScopeRef', input.scope).ok
      )
        return null
      const authorizationRef = randomUUID()
      const scope = Object.freeze(JSON.parse(jcs(input.scope))) as ScopeRef
      const source = Object.freeze(JSON.parse(jcs(input.source))) as ReferenceIdentitySource
      const binding = Object.freeze({
        authorizationRef,
        principalRef: input.principalRef,
        tenantRef: input.tenantRef,
        bindingId: input.bindingId,
        scope,
        source,
      })
      const claims = await ports.claims.create(binding, input.verified)
      if (
        disposed ||
        !ports.sourceCurrent(source) ||
        input.signal.aborted ||
        input.verified.expiresAt <= ports.now() ||
        !ports.claims.validate(claims, binding)
      )
        return null
      const identity = validateRuntime('AuthenticatedIdentity', {
        principalRef: input.principalRef,
        tenantRef: input.tenantRef,
        claims,
        authKind: input.verified.authKind,
        credentialKind: input.verified.credentialKind,
        ownerClass: input.verified.ownerClass,
        authRevision: 1,
        expiresAt: new Date(input.verified.expiresAt).toISOString(),
      })
      if (!identity.ok) return null
      const record = { authorizationRef, bindingId: input.bindingId, scope, identity: identity.value, source }
      database
        .prepare('INSERT INTO reference_identity (id,record) VALUES (?,?)')
        .run(authorizationRef, jcs(record))
      return resolve(authorizationRef)
    },
    issue(reference, input) {
      const instance = resolve(reference)
      if (
        !instance ||
        input.signal.aborted ||
        !(Date.parse(input.deadline) > ports.now()) ||
        !ports.authorize(instance, input)
      )
        return null
      const scope = Object.freeze(JSON.parse(jcs(input.scope))) as ScopeRef
      const value = validateRuntime('CallContextWire', {
        principalRef: instance.identity.principalRef,
        bindingId: input.bindingId,
        scope,
        authorizationRef: reference,
        invocationId: input.invocationId,
        traceRef: input.traceRef,
        deadline: new Date(
          Math.min(Date.parse(input.deadline), Date.parse(instance.identity.expiresAt)),
        ).toISOString(),
      })
      if (!value.ok) return null
      const context: CallContext = Object.freeze({ ...value.value, signal: input.signal })
      contexts.add(context)
      return context
    },
    current(context) {
      if (!contexts.has(context) || context.signal.aborted || !(Date.parse(context.deadline) > ports.now()))
        return null
      const identity = resolve(context.authorizationRef)
      return identity &&
        context.principalRef === identity.identity.principalRef &&
        ports.authorize(identity, context)
        ? identity
        : null
    },
    revoke(reference) {
      return (
        !disposed &&
        database.prepare('UPDATE reference_identity SET revoked=1 WHERE id=? AND revoked=0').run(reference)
          .changes > 0
      )
    },
    close() {
      disposed = true
    },
  }
}
