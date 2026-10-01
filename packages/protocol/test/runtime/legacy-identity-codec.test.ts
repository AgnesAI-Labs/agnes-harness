import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { jcs } from '../../src/jcs.js'
import {
  canonicalJsonDigest,
  type JsonValue,
  RuntimeIdentityLegacySchemas,
  RuntimeSchemaRefs,
  validateIdentityTransportRequest,
  validateRuntime,
} from '../../src/runtime/index.js'
import { loadRuntimeSchemaGraph, validateLegacyIdentityMetadata } from '../../tools/gen-runtime-full.js'
import { runtimeSchemaDocument } from '../../tools/gen-runtime-refs.js'

const directory = fileURLToPath(new URL('../../schema/runtime/', import.meta.url))
const source = { kind: 'source-auth', timestamp: 1, signature: `v0=${'a'.repeat(64)}`, nonce: 'a'.repeat(32) }
const credentials = [
  { kind: 'local' },
  { kind: 'jwt', token: 'synthetic-token' },
  { kind: 'portal-identity', token: 'synthetic-token' },
  source,
  { kind: 'surface', sourceId: 'source', source, subject: { kind: 'jwt', token: 'synthetic-token' } },
  { kind: 'surface', sourceId: 'source', source, subject: { kind: 'portal-identity', token: '' } },
]
const evidence = {
  bindingId: 'binding',
  ingressId: 'ingress',
  connectionId: 'connection',
  clientId: '',
  initializeDigest: 'a'.repeat(64),
  receivedAt: '2026-10-01T00:00:00.000Z',
  transport: 'local',
  localGate: 'local-peer',
  channelBinding: 'b'.repeat(64),
  proof: { kind: 'in-process', issuerBindingId: 'binding' },
}

describe('legacy identity static codecs', () => {
  it.each(credentials)('retains the canonical old Auth constraints for $kind', (credential) => {
    expect(validateRuntime('LegacyIdentityCredentialEnvelope', credential).ok).toBe(true)
  })

  it.each([
    { kind: 'bearer', token: 'synthetic-token' },
    { kind: 'local', actor: 'forged' },
    { kind: 'jwt', token: 'x'.repeat(8193) },
    { ...source, nonce: 'not-a-nonce' },
    { ...source, signature: 'not-a-signature' },
    { ...credentials[4], sourceId: 'Invalid' },
    { ...credentials[4], subject: { kind: 'local' } },
  ])('rejects malformed/unknown old credentials %#', (credential) => {
    expect(validateRuntime('LegacyIdentityCredentialEnvelope', credential).ok).toBe(false)
  })

  it('keeps old secret annotations and references without copying any credential shape', () => {
    const graph = loadRuntimeSchemaGraph(directory)
    expect(graph.publicDocument.$defs?.LegacyIdentityCredentialEnvelope).toEqual({
      $ref: 'https://agnes.ai/schema/agnes-v1.json#/$defs/Auth',
      'x-secret': true,
    })
    const document = runtimeSchemaDocument(graph.document, 'LegacyIdentityCredentialEnvelope')
    expect(createHash('sha256').update(jcs(document), 'utf8').digest('hex')).toBe(
      RuntimeSchemaRefs.LegacyIdentityCredentialEnvelope.digest,
    )
    const original = JSON.parse(readFileSync(new URL('../../schema/channel.json', import.meta.url), 'utf8'))
    for (const name of [
      'Auth',
      'JwtCredential',
      'SourceAuthCredential',
      'PortalIdentityCredential',
      'LocalCredential',
      'SurfaceAuthCredential',
    ]) {
      expect(original.$defs[name]['x-secret']).toBe(true)
      expect(graph.document.$defs?.[`Externalchannel_${name}`]).toMatchObject({ 'x-secret': true })
    }
  })

  it('validates complete connection evidence, including signed proof and an empty client label', () => {
    for (const transport of ['local', 'rpc', 'websocket'])
      for (const localGate of ['none', 'local-peer', 'loopback-host-origin']) {
        expect(
          validateRuntime('LegacyIdentityTransportEvidence', { ...evidence, transport, localGate }).ok,
        ).toBe(true)
      }
    expect(
      validateRuntime('LegacyIdentityTransportEvidence', {
        ...evidence,
        proof: {
          kind: 'signed',
          issuerBindingId: 'binding',
          keyId: 'key',
          expiresAt: evidence.receivedAt,
          signature: 'synthetic-proof',
        },
      }).ok,
    ).toBe(true)
    for (const key of Object.keys(evidence)) {
      const missing: Record<string, unknown> = { ...evidence }
      delete missing[key]
      expect(validateRuntime('LegacyIdentityTransportEvidence', missing).ok, key).toBe(false)
    }
    for (const invalid of [
      { ...evidence, transport: 'http' },
      { ...evidence, localGate: 'trusted' },
      { ...evidence, proof: { kind: 'in-process' } },
      { ...evidence, token: 'secret' },
      { ...evidence, initializeDigest: 'wrong' },
    ])
      expect(validateRuntime('LegacyIdentityTransportEvidence', invalid).ok).toBe(false)
  })

  it('publishes frozen exact Host-only ephemeral metadata and fails generation on drift', () => {
    expect(RuntimeIdentityLegacySchemas).toEqual({
      credentialEnvelope: 'LegacyIdentityCredentialEnvelope',
      transportEvidence: 'LegacyIdentityTransportEvidence',
      proof: 'TransportEvidenceProof',
      requiredFeature: 'identity-legacy-ingress.v1',
      hostOnlyEvidence: true,
      ephemeralOnly: true,
      method: 'initialize',
    })
    expect(Object.isFrozen(RuntimeIdentityLegacySchemas)).toBe(true)
    const { document, publicDocument } = loadRuntimeSchemaGraph(directory)
    const names = new Set(Object.keys(document.$defs ?? {}))
    expect(() => validateLegacyIdentityMetadata(publicDocument, names)).not.toThrow()
    for (const patch of [
      { hostOnlyEvidence: false },
      { ephemeralOnly: false },
      { method: 'authenticate' },
      { extra: true },
      { credentialEnvelope: 'TransportCredentialEnvelope' },
    ]) {
      expect(() =>
        validateLegacyIdentityMetadata(
          { ...publicDocument, 'x-identity-legacy-schemas': { ...RuntimeIdentityLegacySchemas, ...patch } },
          names,
        ),
      ).toThrow('invalid legacy identity')
    }
    expect(() =>
      validateLegacyIdentityMetadata(
        {
          ...publicDocument,
          $defs: { ...publicDocument.$defs, LegacyIdentityCredentialEnvelope: { type: 'object' } },
        },
        names,
      ),
    ).toThrow()
    expect(() =>
      validateLegacyIdentityMetadata(
        {
          ...publicDocument,
          'x-schema-ids': {
            ...(publicDocument['x-schema-ids'] as object),
            LegacyIdentityCredentialEnvelope: 'agh.identity/transport-credential@1',
          },
        },
        names,
      ),
    ).toThrow()
    expect(() => validateLegacyIdentityMetadata(publicDocument, new Set())).toThrow()
  })

  it('keeps HTTP/WS decoding confined to its original schema-ref family', () => {
    const inline = (schema: object, value: JsonValue) => ({
      kind: 'inline',
      schema,
      value,
      bytes: new TextEncoder().encode(jcs(value)).length,
      digest: canonicalJsonDigest(value),
    })
    const request = {
      credentialEnvelope: inline(
        RuntimeSchemaRefs.LegacyIdentityCredentialEnvelope,
        credentials[0] as JsonValue,
      ),
      transportEvidence: inline(RuntimeSchemaRefs.LegacyIdentityTransportEvidence, evidence),
    }
    expect(validateRuntime('IdentityAuthenticateRequest', request).ok).toBe(true)
    expect(validateIdentityTransportRequest(request).ok).toBe(false)
    const httpEvidence = {
      bindingId: 'binding',
      ingressId: 'ingress',
      requestNonce: 'nonce',
      receivedAt: evidence.receivedAt,
      transport: 'websocket',
      method: 'GET',
      path: '/api/runtime/client/stream',
      origin: null,
      authority: 'localhost',
      peerLoopback: true,
      tls: false,
      channelBinding: 'a'.repeat(64),
      proof: evidence.proof,
    }
    const httpRequest = {
      credentialEnvelope: inline(RuntimeSchemaRefs.TransportCredentialEnvelope, {
        kind: 'bearer',
        token: 'synthetic-token',
      }),
      transportEvidence: inline(RuntimeSchemaRefs.TransportAuthenticationEvidence, httpEvidence),
    }
    expect(validateIdentityTransportRequest(httpRequest).ok).toBe(true)
    for (const changed of [
      {
        ...httpRequest,
        credentialEnvelope: {
          ...httpRequest.credentialEnvelope,
          schema: RuntimeSchemaRefs.LegacyIdentityCredentialEnvelope,
        },
      },
      {
        ...httpRequest,
        transportEvidence: {
          ...httpRequest.transportEvidence,
          schema: RuntimeSchemaRefs.LegacyIdentityTransportEvidence,
        },
      },
    ]) {
      expect(validateRuntime('IdentityAuthenticateRequest', changed).ok).toBe(true)
      expect(validateIdentityTransportRequest(changed).ok).toBe(false)
    }
  })
})
