import type { DatabaseSync } from 'node:sqlite'
import { jcs } from '@agnes/protocol'
import {
  type ClientModuleCredentialBinding,
  canonicalJsonDigest,
  type ScopeRef,
  type TransportAuthenticationEvidence,
  type TransportCredentialEnvelope,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { ReferenceCredential } from './verify.js'

type SessionBinding = Readonly<{
  principalKey: string
  tenantRef: string
  bindingId: string
  scope: ScopeRef
  expiresAt: number
  credentialRevision: number
  verified: ReferenceCredential
  module?: ClientModuleCredentialBinding
}>

/** Independent token map: no default session implementation or private tables are imported. */
export function createReferenceIdentitySessions(
  database: DatabaseSync,
  ports: {
    now(): number
    current(binding: SessionBinding, evidence: TransportAuthenticationEvidence): boolean
    currentBinding(binding: SessionBinding): boolean
  },
) {
  database.exec(
    'CREATE TABLE IF NOT EXISTS reference_token (hash TEXT PRIMARY KEY,kind TEXT NOT NULL,binding TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0)',
  )
  return {
    install(token: string, kind: TransportCredentialEnvelope['kind'], binding: SessionBinding): void {
      if (
        token.length < 32 ||
        !validateRuntime('ScopeRef', binding.scope).ok ||
        !binding.principalKey ||
        !binding.tenantRef ||
        !binding.bindingId ||
        !Number.isSafeInteger(binding.credentialRevision) ||
        binding.credentialRevision < 1 ||
        binding.expiresAt <= ports.now() ||
        binding.verified.expiresAt < binding.expiresAt ||
        (kind === 'module-session' &&
          (!binding.module || !validateRuntime('ClientModuleCredentialBinding', binding.module).ok))
      )
        throw new Error('invalid reference token binding')
      database
        .prepare('INSERT INTO reference_token(hash,kind,binding) VALUES (?,?,?)')
        .run(canonicalJsonDigest(token), kind, jcs(binding))
    },
    authenticate(
      input: TransportCredentialEnvelope,
      evidence: TransportAuthenticationEvidence,
      tenantRef: string,
      scope: ScopeRef,
    ): ReferenceCredential | null {
      const row = database
        .prepare('SELECT * FROM reference_token WHERE hash=?')
        .get(canonicalJsonDigest(input.token))
      if (row?.revoked !== 0 || row.kind !== input.kind || typeof row.binding !== 'string') return null
      try {
        const binding = JSON.parse(row.binding) as SessionBinding
        if (binding.verified.ownerClass === 'local-owner' && !evidence.peerLoopback) return null
        if (
          binding.tenantRef !== tenantRef ||
          binding.bindingId !== evidence.bindingId ||
          jcs(binding.scope) !== jcs(scope) ||
          binding.expiresAt <= ports.now() ||
          binding.verified.expiresAt <= ports.now() ||
          !ports.currentBinding(binding) ||
          !ports.current(binding, evidence)
        )
          return null
        if (
          input.kind === 'module-session' &&
          (!binding.module ||
            !validateRuntime('ClientModuleCredentialBinding', binding.module).ok ||
            Date.parse(binding.module.expiresAt) <= ports.now() ||
            binding.module.tenantRef !== tenantRef ||
            binding.module.channelBinding !== evidence.channelBinding ||
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
          credentialOwnerRef: canonicalJsonDigest(input.token),
          credentialRevision: binding.credentialRevision,
          ...(binding.module ? { principalRef: binding.module.principalRef } : {}),
        })
      } catch {
        return null
      }
    },
    known(token: string): boolean {
      return !!database
        .prepare('SELECT hash FROM reference_token WHERE hash=?')
        .get(canonicalJsonDigest(token))
    },
    revoke(token: string): boolean {
      return (
        database
          .prepare('UPDATE reference_token SET revoked=1 WHERE hash=? AND revoked=0')
          .run(canonicalJsonDigest(token)).changes > 0
      )
    },
    current(ownerRef: string, revision: number): boolean {
      const row = database.prepare('SELECT * FROM reference_token WHERE hash=?').get(ownerRef)
      if (row?.revoked !== 0 || typeof row.binding !== 'string') return false
      try {
        const binding = JSON.parse(row.binding) as SessionBinding
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
