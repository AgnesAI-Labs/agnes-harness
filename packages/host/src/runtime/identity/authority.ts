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
  const contexts = new WeakMap<object, { authorizationRef: string; bindingId: string; scope: string }>()
  let closed = false
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
      return Object.freeze({
        authorizationRef,
        bindingId: row.binding_id,
        scope: Object.freeze(scope.value),
        identity: Object.freeze(identity.value),
        source,
      })
    } catch {
      return null
    }
  }
  return {
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
      contexts.set(context, { authorizationRef, bindingId: input.bindingId, scope: jcs(scope) })
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
        authorizeBinding(instance, context)
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
}
