import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { jcs } from '@agnes/protocol'
import {
  type ClientModuleCredentialBinding,
  type ScopeRef,
  type TransportAuthenticationEvidence,
  type TransportCredentialEnvelope,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { VerifiedIdentityCredential } from './verify.js'

export type IdentitySessionBinding = Readonly<{
  principalKey: string
  tenantRef: string
  bindingId: string
  scope: ScopeRef
  expiresAt: number
  credentialRevision: number
  verified: VerifiedIdentityCredential
  module?: ClientModuleCredentialBinding
}>

/** Deployment-owned token sessions. Inputs are persisted before a token is offered to any client. */
export interface IdentityHttpSessions {
  install(token: string, kind: TransportCredentialEnvelope['kind'], binding: IdentitySessionBinding): void
  authenticate(
    credential: TransportCredentialEnvelope,
    evidence: TransportAuthenticationEvidence,
    tenantRef: string,
    scope: ScopeRef,
  ): VerifiedIdentityCredential | null
  revoke(token: string): boolean
  known(token: string): boolean
  current(ownerRef: string, revision: number): boolean
}

export function createIdentityHttpSessions(
  database: DatabaseSync,
  ports: {
    now(): number
    current(binding: IdentitySessionBinding, evidence: TransportAuthenticationEvidence): boolean
    currentBinding(binding: IdentitySessionBinding): boolean
  },
): IdentityHttpSessions {
  database.exec(`CREATE TABLE IF NOT EXISTS runtime_identity_http_sessions (
    token_digest TEXT PRIMARY KEY, kind TEXT NOT NULL, binding_json TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
  )`)
  const digest = (token: string) => createHash('sha256').update(token).digest('hex')
  return {
    install(token, kind, binding) {
      if (
        !token ||
        token.length < 32 ||
        !validateRuntime('ScopeRef', binding.scope).ok ||
        !Number.isSafeInteger(binding.credentialRevision) ||
        binding.credentialRevision < 1 ||
        binding.expiresAt <= ports.now() ||
        binding.verified.expiresAt < binding.expiresAt ||
        !binding.principalKey ||
        !binding.tenantRef ||
        !binding.bindingId ||
        (kind === 'module-session' &&
          (!binding.module || !validateRuntime('ClientModuleCredentialBinding', binding.module).ok))
      )
        throw new Error('invalid deployment token binding')
      // Installation cannot overwrite a revoked token and bring its authority back to life.
      database
        .prepare(
          'INSERT INTO runtime_identity_http_sessions (token_digest, kind, binding_json) VALUES (?, ?, ?)',
        )
        .run(digest(token), kind, jcs(binding))
    },
    authenticate(credential, evidence, tenantRef, scope) {
      const row = database
        .prepare('SELECT * FROM runtime_identity_http_sessions WHERE token_digest = ?')
        .get(digest(credential.token))
      if (row?.revoked !== 0 || row.kind !== credential.kind || typeof row.binding_json !== 'string')
        return null
      try {
        const binding = JSON.parse(row.binding_json) as IdentitySessionBinding
        if (binding.verified.ownerClass === 'local-owner' && !evidence.peerLoopback) return null
        if (
          binding.expiresAt <= ports.now() ||
          binding.verified.expiresAt <= ports.now() ||
          binding.tenantRef !== tenantRef ||
          binding.bindingId !== evidence.bindingId ||
          jcs(binding.scope) !== jcs(scope) ||
          !ports.currentBinding(binding) ||
          !ports.current(binding, evidence)
        )
          return null
        if (
          credential.kind === 'module-session' &&
          (!binding.module ||
            !validateRuntime('ClientModuleCredentialBinding', binding.module).ok ||
            Date.parse(binding.module.expiresAt) <= ports.now() ||
            binding.module.channelBinding !== evidence.channelBinding ||
            binding.module.tenantRef !== tenantRef ||
            binding.module.credentialRevision !== binding.credentialRevision)
        )
          return null
        return Object.freeze({
          ...binding.verified,
          expiresAt: Math.min(
            binding.expiresAt,
            binding.verified.expiresAt,
            binding.module ? Date.parse(binding.module.expiresAt) : Number.POSITIVE_INFINITY,
          ),
          credentialOwnerRef: digest(credential.token),
          credentialRevision: binding.credentialRevision,
          ...(binding.module ? { principalRef: binding.module.principalRef } : {}),
        })
      } catch {
        return null
      }
    },
    revoke(token) {
      return (
        database
          .prepare(
            'UPDATE runtime_identity_http_sessions SET revoked = 1 WHERE token_digest = ? AND revoked = 0',
          )
          .run(digest(token)).changes > 0
      )
    },
    known(token) {
      return !!database
        .prepare('SELECT 1 FROM runtime_identity_http_sessions WHERE token_digest = ?')
        .get(digest(token))
    },
    current(ownerRef, revision) {
      const row = database
        .prepare('SELECT * FROM runtime_identity_http_sessions WHERE token_digest = ?')
        .get(ownerRef)
      if (row?.revoked !== 0 || typeof row.binding_json !== 'string') return false
      try {
        const binding = JSON.parse(row.binding_json) as IdentitySessionBinding
        return (
          binding.credentialRevision === revision &&
          binding.expiresAt > ports.now() &&
          binding.verified.expiresAt > ports.now() &&
          (!binding.module || Date.parse(binding.module.expiresAt) > ports.now()) &&
          ports.currentBinding(binding)
        )
      } catch {
        return false
      }
    },
  }
}
