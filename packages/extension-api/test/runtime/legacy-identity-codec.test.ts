import type {
  LegacyIdentityCredentialEnvelope,
  LegacyIdentityTransportEvidence,
} from '@agnes/extension-api/runtime'
import { runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
import { canonicalJsonDigest, RuntimeSchemaRefs } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'

const source = {
  kind: 'source-auth',
  timestamp: 1,
  signature: `v0=${'a'.repeat(64)}`,
  nonce: 'a'.repeat(32),
} as const
const credentials: LegacyIdentityCredentialEnvelope[] = [
  { kind: 'local' },
  { kind: 'jwt', token: 'synthetic-token' },
  { kind: 'portal-identity', token: '' },
  source,
  { kind: 'surface', sourceId: 'source', source, subject: { kind: 'jwt', token: 'synthetic-token' } },
]
const evidence: LegacyIdentityTransportEvidence = {
  bindingId: 'binding',
  ingressId: 'ingress',
  connectionId: 'connection',
  clientId: '',
  initializeDigest: 'a'.repeat(64),
  receivedAt: '2026-10-01T00:00:00.000Z',
  transport: 'rpc',
  localGate: 'none',
  channelBinding: 'b'.repeat(64),
  proof: { kind: 'in-process', issuerBindingId: 'binding' },
}

describe('official legacy identity author codecs', () => {
  it.each(credentials)(
    'encodes $kind using its registered schema and immutable JSON snapshot',
    (credential) => {
      const encoded = runtimeAuthorSchemas.LegacyIdentityCredentialEnvelope.encode(credential)
      expect(encoded.ok).toBe(true)
      if (!encoded.ok) throw new Error('valid credential encoding failed')
      expect(encoded.value.kind).toBe('inline')
      if (encoded.value.kind !== 'inline') throw new Error('expected inline encoding')
      expect(encoded.value.schema).toEqual(RuntimeSchemaRefs.LegacyIdentityCredentialEnvelope)
      expect(encoded.value.digest).toBe(canonicalJsonDigest(credential))
      expect(encoded.value.value).toEqual(credential)
      expect(Object.isFrozen(encoded.value.value)).toBe(true)
      expect(runtimeAuthorSchemas.LegacyIdentityCredentialEnvelope.parse(encoded.value.value)).toEqual({
        ok: true,
        value: credential,
      })
    },
  )

  it('encodes evidence using its own official identity without deriving current authorization', () => {
    const encoded = runtimeAuthorSchemas.LegacyIdentityTransportEvidence.encode(evidence)
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) throw new Error('valid evidence encoding failed')
    expect(encoded.value.schema).toEqual(RuntimeSchemaRefs.LegacyIdentityTransportEvidence)
    expect(runtimeAuthorSchemas.LegacyIdentityTransportEvidence.parse(evidence)).toEqual({
      ok: true,
      value: evidence,
    })
    expect(runtimeAuthorSchemas.LegacyIdentityCredentialEnvelope.ref.revision).toBe(1)
    expect(runtimeAuthorSchemas.LegacyIdentityTransportEvidence.ref.revision).toBe(1)
  })

  it('rejects malformed credentials/evidence without reading getters or granting privileges', () => {
    expect(
      runtimeAuthorSchemas.LegacyIdentityCredentialEnvelope.parse({ kind: 'local', actor: 'forged' }).ok,
    ).toBe(false)
    expect(
      runtimeAuthorSchemas.LegacyIdentityCredentialEnvelope.parse({ kind: 'jwt', token: 'x'.repeat(8193) })
        .ok,
    ).toBe(false)
    expect(
      runtimeAuthorSchemas.LegacyIdentityTransportEvidence.parse({
        ...evidence,
        proof: { kind: 'in-process' },
      }).ok,
    ).toBe(false)
    let reads = 0
    expect(
      runtimeAuthorSchemas.LegacyIdentityCredentialEnvelope.parse({
        kind: 'jwt',
        get token() {
          reads++
          return 'synthetic-token'
        },
      }).ok,
    ).toBe(false)
    expect(reads).toBe(0)
  })
})
