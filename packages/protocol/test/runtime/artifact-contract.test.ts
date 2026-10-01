import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { RuntimeError } from '../../src/runtime/index.js'
import {
  RuntimeArtifactPolicy,
  RuntimeErrorDetails,
  RuntimeServiceCatalog,
  runtimeErrorHttpStatus,
  validateRuntime,
  validateRuntimeErrorDetail,
} from '../../src/runtime/index.js'
import { runtimeSchemaDocument } from '../../src/runtime/schema-document.js'
import { generateRuntimeArtifactArtifacts } from '../../tools/gen-runtime-artifacts.js'
import { loadRuntimeSchemaGraph } from '../../tools/gen-runtime-graph.js'

const schema = { typeId: 'demo/content@1', revision: 1, digest: 'a'.repeat(64) }
const reserve = {
  publicationId: 'publication',
  artifactId: null,
  expectedLatestVersion: null,
  kind: schema.typeId,
  schema,
  title: null,
  mediaType: null,
  ownerActionRef: { existingActionId: 'action' },
}
const blob = {
  authorityId: 'blob',
  blobId: 'content',
  digest: 'a'.repeat(64),
  bytes: 1,
  mediaType: 'application/octet-stream',
  pinId: 'pin',
}
const publish = {
  publicationId: 'publication',
  expectedRevision: 1,
  source: { kind: 'blob', blob },
  title: 'Document',
  mediaType: blob.mediaType,
}
const error = (code: RuntimeError['code'], detailCode: string): RuntimeError => ({
  code,
  detailCode,
  message: 'safe',
  diagnosticId: 'diagnostic',
  retryAdvice: { kind: 'never' },
})

describe('artifact publication and delivery contracts', () => {
  it('matches independent JSON Schema validation for nullable versions and byte limits', () => {
    const require = createRequire(import.meta.url)
    const Ajv = require('ajv/dist/2020.js').default
    const formats = require('ajv-formats')
    const ajv = new Ajv({ strict: false })
    formats(ajv)
    ajv.addKeyword({
      keyword: 'x-max-utf8-bytes',
      schemaType: 'number',
      type: 'string',
      validate: (limit: number, value: string) => Buffer.byteLength(value, 'utf8') <= limit,
    })
    const directory = fileURLToPath(new URL('../../schema/runtime', import.meta.url))
    const { document } = loadRuntimeSchemaGraph(directory)
    const check = ajv.compile(runtimeSchemaDocument(document, 'ArtifactsReserveRequest'))
    for (const value of [
      reserve,
      { ...reserve, artifactId: 'existing', expectedLatestVersion: 1 },
      { ...reserve, artifactId: 'existing' },
      { ...reserve, expectedLatestVersion: 1 },
      { ...reserve, title: '😀'.repeat(256) },
      { ...reserve, title: `${'😀'.repeat(256)}a` },
      { ...reserve, mediaType: `application/${'a'.repeat(243)}` },
      { ...reserve, mediaType: `application/${'a'.repeat(244)}` },
    ])
      expect(validateRuntime('ArtifactsReserveRequest', value).ok).toBe(check(value))
  })
  it.each([
    [reserve, true],
    [{ ...reserve, title: 'Known' }, true],
    [{ ...reserve, artifactId: 'existing', expectedLatestVersion: 1 }, true],
    [{ ...reserve, artifactId: 'existing' }, false],
    [{ ...reserve, expectedLatestVersion: 1 }, false],
    [{ ...reserve, artifactId: 'existing', expectedLatestVersion: 0 }, false],
    [{ ...reserve, artifactId: 'existing', expectedLatestVersion: -0 }, false],
    [{ ...reserve, artifactId: 'existing', expectedLatestVersion: 0.5 }, false],
    [{ ...reserve, title: '😀'.repeat(256) }, true],
    [{ ...reserve, title: `${'😀'.repeat(256)}a` }, false],
    [{ ...reserve, title: 'bad\nheader' }, false],
    [{ ...reserve, title: '' }, false],
    [{ ...reserve, mediaType: 'application/octet-stream\r\nX-Test:bad' }, false],
    [{ ...reserve, publicationId: undefined }, false],
    [{ ...reserve, grant: true }, false],
  ])('checks reservation version and UTF-8 limits %#', (value, valid) => {
    expect(validateRuntime('ArtifactsReserveRequest', value).ok).toBe(valid)
  })

  it.each([
    [publish, true],
    [{ ...publish, title: null }, false],
    [{ ...publish, mediaType: null }, false],
    [{ ...publish, source: null }, false],
    [{ ...publish, source: { kind: 'blob', blob: { ...blob, pinId: null } } }, false],
  ])('requires final publication content %#', (value, valid) => {
    expect(validateRuntime('ArtifactsPublishRequest', value).ok).toBe(valid)
  })

  it('separates a reserved projection from a ready delivery without a second shape', () => {
    const reserved = {
      artifactId: 'artifact',
      version: 1,
      title: null,
      mime: null,
      size: null,
      status: 'reserved',
    }
    const ready = { ...reserved, title: 'Ready', mime: 'text/plain', size: 0, status: 'ready' }
    expect(validateRuntime('ArtifactViewRef', reserved).ok).toBe(true)
    expect(validateRuntime('ArtifactViewRef', { ...ready, title: null }).ok).toBe(false)
    expect(validateRuntime('ArtifactRef', { artifactId: 'artifact', version: 0 }).ok).toBe(false)
    const presentation = {
      artifact: ready,
      disposition: 'attachment',
      expiresAt: '2026-10-01T00:05:00.000Z',
      grantRevision: 1,
    }
    expect(validateRuntime('ArtifactDownloadPresentation', presentation).ok).toBe(true)
    expect(validateRuntime('ArtifactDownloadPresentation', { ...presentation, artifact: reserved }).ok).toBe(
      false,
    )
    expect(
      validateRuntime('ArtifactDownloadMetadata', {
        stream: { streamId: 'stream', offset: 0, totalBytes: 0 },
        download: presentation,
      }).ok,
    ).toBe(true)
    expect(
      validateRuntime('ArtifactDownloadMetadata', {
        stream: { streamId: 'stream', offset: 0, totalBytes: 0 },
        download: presentation,
        chunks: [],
      }).ok,
    ).toBe(false)
  })

  it('keeps aborted observable without accepting it as a sealed reference', () => {
    expect(
      validateRuntime('BlobInspectResult', { status: 'aborted', bytes: 3, digest: null, ownerRefs: [] }).ok,
    ).toBe(true)
    expect(
      validateRuntime('UploadRef', {
        authorityId: 'blob',
        uploadId: 'upload',
        reservationId: 'reservation',
        digest: blob.digest,
        bytes: 3,
        mediaType: blob.mediaType,
        status: 'aborted',
      }).ok,
    ).toBe(false)
    expect(RuntimeArtifactPolicy.uploadReservationTtlMs).toBe(86_400_000)
    expect(RuntimeArtifactPolicy.downloadTicketTtlMs).toBe(300_000)
  })

  it('limits inspect references and requires sealed content digests', () => {
    expect(validateRuntime('BlobInspectRequest', { ref: { kind: 'blob', value: blob } }).ok).toBe(true)
    expect(
      validateRuntime('BlobInspectRequest', {
        ref: { kind: 'artifact', value: { artifactId: 'artifact', version: 1 } },
      }).ok,
    ).toBe(false)
    for (const status of ['sealed', 'staged', 'pinned']) {
      expect(
        validateRuntime('BlobInspectResult', { status, bytes: 3, digest: blob.digest, ownerRefs: [] }).ok,
      ).toBe(true)
      expect(validateRuntime('BlobInspectResult', { status, bytes: 3, digest: null, ownerRefs: [] }).ok).toBe(
        false,
      )
    }
    expect(
      validateRuntime('BlobInspectResult', {
        status: 'uploading',
        bytes: 3,
        digest: blob.digest,
        ownerRefs: [],
      }).ok,
    ).toBe(false)
  })

  it.each([
    ['A'.repeat(43), true],
    [`${'A'.repeat(42)}B`, false],
    [`${'A'.repeat(42)}=`, false],
    ['A'.repeat(42), false],
    ['A'.repeat(44), false],
  ])('checks canonical 32-byte delivery nonces %#', (nonce, valid) => {
    expect(
      validateRuntime('ArtifactRedeemDownloadRequest', { ticketId: 'ticket', nonce, offset: 0 }).ok,
    ).toBe(valid)
  })

  it('keeps delivery Local and forbids the broker and generic Wire query surfaces', () => {
    const method = RuntimeServiceCatalog['agh.artifacts'].methods.redeemDownload
    expect(method).toMatchObject({
      local: true,
      localInterface: 'ArtifactAccessPort',
      kind: 'query',
      requiredFeature: 'artifact-ticket.v1',
      sameAttemptBrokerAllowed: false,
    })
    expect(method).not.toHaveProperty('inputTypeId')
    expect(method).not.toHaveProperty('output')
    expect(RuntimeServiceCatalog['agh.artifacts'].methods.fail.sameAttemptBrokerAllowed).toBe(false)
    expect(Object.isFrozen(RuntimeArtifactPolicy.reserve)).toBe(true)
  })
})

describe('single-source RuntimeError classification', () => {
  it.each([
    ['invalid_input', 'not_found', 404],
    ['invalid_input', 'range_not_satisfiable', 416],
    ['denied', 'revoked', 403],
    ['denied', 'blocked', 403],
    ['incompatible', 'operation_not_supported', 409],
    ['incompatible', 'unsupported', 409],
    ['internal', 'integrity', 500],
    ['quota', 'range_bytes', 413],
  ] as const)('maps %s/%s without changing the ten-code enum', (code, detail, status) => {
    expect(validateRuntimeErrorDetail(error(code, detail)).ok).toBe(true)
    expect(runtimeErrorHttpStatus(error(code, detail))).toBe(status)
    expect(validateRuntimeErrorDetail(error('retryable', detail)).ok).toBe(false)
  })

  it('keeps reset and unknown effects distinct from automatic retry', () => {
    for (const detail of ['catalog_changed', 'resync_required']) {
      const reset: RuntimeError = { ...error('conflict', detail), retryAdvice: { kind: 'retry_read' } }
      expect(validateRuntimeErrorDetail(reset).ok).toBe(true)
      expect(runtimeErrorHttpStatus(reset)).toBe(409)
      expect(validateRuntimeErrorDetail(error('conflict', detail)).ok).toBe(false)
    }
    const unknown: RuntimeError = {
      ...error('unknown_effect', 'effect_unknown'),
      retryAdvice: { kind: 'reconcile', ownerRef: { kind: 'reconciliation', id: 'owner' } },
    }
    expect(validateRuntimeErrorDetail(unknown).ok).toBe(true)
    expect(validateRuntimeErrorDetail(error('unknown_effect', 'effect_unknown')).ok).toBe(false)
    expect(validateRuntimeErrorDetail({ ...unknown, code: 'timeout' }).ok).toBe(false)
    expect(runtimeErrorHttpStatus(error('internal', 'future_extension'))).toBe(500)
    expect(runtimeErrorHttpStatus(error('internal', 'toString'))).toBe(500)
    expect(validateRuntimeErrorDetail({ ...unknown, code: 'future_code' }).ok).toBe(false)
    expect(Object.isFrozen(RuntimeErrorDetails.revoked)).toBe(true)
    expect(Object.isFrozen(RuntimeErrorDetails.revoked.retryAdviceKinds)).toBe(true)
  })

  it('refuses inconsistent source policies before generation', () => {
    const directory = fileURLToPath(new URL('../../schema/runtime', import.meta.url))
    const { document } = loadRuntimeSchemaGraph(directory)
    const source = JSON.parse(readFileSync(`${directory}/public.json`, 'utf8'))
    expect(() => generateRuntimeArtifactArtifacts(source, document)).not.toThrow()
    const bad = structuredClone(source)
    bad['x-runtime-error-details'].revoked.code = 'future_code'
    expect(() => generateRuntimeArtifactArtifacts(bad, document)).toThrow(/detail/)
    bad['x-runtime-error-details'].revoked.code = 'denied'
    bad['x-artifact-policy'].maxTitleBytes++
    expect(() => generateRuntimeArtifactArtifacts(bad, document)).toThrow(/disagrees/)
  })
})
