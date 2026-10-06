import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { createAuthorSchema } from '../../src/runtime/authoring-schema-core.js'
import type { ArtifactDraft, CallContext } from '../../src/runtime/index.js'
import { defineArtifactTool, runArtifactTool, runtimeAuthorSchemas } from '../../src/runtime/index.js'
import { createRestrictedEffectsFixture } from '../../testkit/runtime/effects.js'

describe('artifact author declaration inputs', () => {
  it('binds the official descriptor and prepares reserve-before-render and final publication', () => {
    let renders = 0
    const declaration = defineArtifactTool({
      id: 'document',
      description: 'A document',
      input: runtimeAuthorSchemas.StandardToolOutput,
      render() {
        renders++
        return { title: 'Ready', mediaType: 'text/plain', bytes: new Uint8Array() }
      },
    })
    expect(renders).toBe(0)
    expect(declaration.publication.contentSchema.ref).toEqual(RuntimeSchemaRefs.ArtifactContentDescriptor)
    expect(declaration.publication.reserve).toEqual(RuntimeMethodSchemaRefs['agh.artifacts'].reserve)
    expect(Object.isFrozen(declaration.publication)).toBe(true)
    const reserve = declaration.publication.prepareReserve({
      publicationId: 'publication',
      artifactId: null,
      expectedLatestVersion: null,
      ownerActionRef: { existingActionId: 'action' },
      title: null,
      mediaType: null,
    })
    expect(reserve.schema).toEqual(RuntimeSchemaRefs.ArtifactContentDescriptor)
    expect(reserve.kind).toBe('agh.artifacts/content-descriptor@1')
    expect(validateRuntime('ArtifactsReserveRequest', reserve).ok).toBe(true)
    const next = declaration.publication.prepareReserve({
      publicationId: 'next',
      artifactId: 'existing',
      expectedLatestVersion: 1,
      ownerActionRef: { existingActionId: 'action' },
      title: null,
      mediaType: null,
    })
    expect(next.artifactId).toBe('existing')
  })

  it('keeps publication builders pure and rejects caller schema replacement or MIME laundering', () => {
    const declaration = defineArtifactTool({
      id: 'document',
      description: 'Document',
      input: runtimeAuthorSchemas.StandardToolOutput,
      render: () => ({ title: 'Ready', mediaType: 'text/plain', bytes: new Uint8Array() }),
    })
    const input = {
      publicationId: 'publication',
      artifactId: null,
      expectedLatestVersion: null,
      title: null,
      mediaType: null,
      ownerActionRef: { existingActionId: 'action' },
    }
    expect(() =>
      Reflect.apply(declaration.publication.prepareReserve, undefined, [
        { ...input, schema: RuntimeSchemaRefs.StandardToolOutput },
      ]),
    ).toThrow(/locked descriptor/)
    expect(() =>
      Reflect.apply(declaration.publication.prepareReserve, undefined, [
        { ...input, artifactId: 'existing' },
      ]),
    ).toThrow(/reservation/)
    const blob = {
      authorityId: 'blob',
      blobId: 'content',
      digest: 'a'.repeat(64),
      bytes: 3,
      mediaType: 'text/plain',
      pinId: 'pin',
    }
    const final = {
      publicationId: 'publication',
      expectedRevision: 1,
      source: { kind: 'blob' as const, blob },
      title: 'Ready',
      mediaType: 'text/plain',
    }
    expect(declaration.publication.preparePublish(final)).toEqual(final)
    expect(() =>
      declaration.publication.preparePublish({ ...final, mediaType: 'application/octet-stream' }),
    ).toThrow(/does not match/)
    expect(() =>
      Reflect.apply(declaration.publication.preparePublish, undefined, [{ ...final, title: null }]),
    ).toThrow(/publication/)
    const descriptor = declaration.publication.contentSchema.encode({
      title: 'Ready',
      mediaType: 'text/plain',
      bytes: 3,
      digest: blob.digest,
    })
    expect(descriptor.ok).toBe(true)
    expect(
      declaration.publication.contentSchema.parse({
        title: 'Ready',
        mediaType: 'text/plain',
        bytes: -0,
        digest: blob.digest,
      }).ok,
    ).toBe(false)
  })
})

const methods = RuntimeMethodSchemaRefs['agh.artifacts']
const reply = {
  reserve: createAuthorSchema(methods.reserve.output, (value) =>
    validateRuntime('ArtifactReservation', value),
  ),
  publish: createAuthorSchema(methods.publish.output, (value) =>
    validateRuntime('ArtifactReservation', value),
  ),
}
const publicationId = canonicalJsonDigest({ ownerActionId: 'action', purpose: 'agh.artifacts/publication' })
const upload: Wire.UploadRef = {
  authorityId: 'blob',
  uploadId: 'upload',
  reservationId: 'upload-reservation',
  digest: 'b'.repeat(64),
  bytes: 5,
  mediaType: 'text/markdown',
  status: 'sealed',
}
const reserved: Wire.ArtifactReservation = {
  publicationId,
  artifactId: 'artifact',
  version: 1,
  revision: 1,
  schema: RuntimeSchemaRefs.ArtifactContentDescriptor,
  kind: 'agh.artifacts/content-descriptor@1',
  title: null,
  mediaType: null,
  ownerAction: {
    run: {
      runId: 'run',
      session: {
        sessionId: 'session',
        authority: { authorityId: 'state', tenantId: 'tenant', authorityEpoch: 1 },
      },
    },
    actionId: 'action',
  },
  state: 'reserved',
  source: null,
  pinId: null,
  failureRef: null,
  blob: null,
}
const ready: Wire.ArtifactReservation = {
  ...reserved,
  revision: 3,
  title: 'Notes',
  mediaType: 'text/markdown',
  state: 'ready',
  source: { kind: 'upload', upload },
  pinId: 'pin',
  blob: {
    authorityId: 'blob',
    blobId: 'content',
    digest: upload.digest,
    bytes: 5,
    mediaType: 'text/markdown',
    pinId: 'pin',
  },
}

function attempt(
  draft: () => ArtifactDraft = () => ({
    title: 'Notes',
    mediaType: 'text/markdown',
    bytes: new Uint8Array(5),
  }),
) {
  const fixture = createRestrictedEffectsFixture()
  const abort = new AbortController()
  const requests: Wire.JsonValue[] = []
  let renders = 0
  const tool = defineArtifactTool({
    id: 'notes',
    description: 'Notes',
    input: runtimeAuthorSchemas.StandardToolOutput,
    render() {
      renders++
      return draft()
    },
  })
  const call: CallContext = {
    principalRef: 'principal',
    bindingId: 'binding',
    invocationId: 'invoke',
    deadline: '2099-01-01T00:00:00.000Z',
    traceRef: 'trace',
    authorizationRef: 'authorization',
    signal: abort.signal,
    scope: {
      kind: 'action',
      installationId: 'installation',
      runtimeId: 'runtime',
      workspaceId: 'workspace',
      sessionId: 'session',
      runId: 'run',
      actionId: 'action',
    },
  }
  function grant(method: 'reserve' | 'publish', record: unknown, onCall?: () => void) {
    fixture.allow({
      port: 'invoke',
      operation: `agh.artifacts.${method}`,
      async handle(request) {
        onCall?.()
        if (request.input.kind === 'inline') requests.push(request.input.value)
        const encoded = reply[method].encode(record as Wire.ArtifactReservation)
        if (!encoded.ok) throw new Error('fixture reservation is invalid')
        return encoded
      },
    })
  }
  const run = (sealed: { upload: Wire.UploadRef; title: string } | null = null) =>
    runArtifactTool(tool, { content: [] }, { effects: fixture.ports, call, target: null, sealed })
  const operations = () => fixture.calls().map((item) => `${item.port}:${item.operation}`)
  return { fixture, abort, requests, grant, run, operations, renders: () => renders }
}

describe('standard artifact adapter over restricted Effects', () => {
  it('reserves under a stable owner key, renders once, then refuses staging without publishing', async () => {
    const t = attempt()
    t.grant('reserve', reserved)
    const result = await t.run()
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'incompatible', detailCode: 'operation_not_supported' },
    })
    expect(t.renders()).toBe(1)
    expect(t.operations()).toEqual(['invoke:agh.artifacts.reserve'])
    expect(t.requests[0]).toMatchObject({
      publicationId,
      ownerActionRef: { existingActionId: 'action' },
      schema: RuntimeSchemaRefs.ArtifactContentDescriptor,
      title: null,
      mediaType: null,
    })
    await t.run()
    expect(t.requests[1]).toEqual(t.requests[0])
  })

  it('resumes from a committed sealed receipt to a ready ArtifactRef without rendering', async () => {
    const t = attempt()
    t.grant('reserve', reserved)
    t.grant('publish', ready)
    expect(await t.run({ upload, title: 'Notes' })).toEqual({
      ok: true,
      value: { artifactId: 'artifact', version: 1 },
    })
    expect(t.renders()).toBe(0)
    expect(t.operations()).toEqual(['invoke:agh.artifacts.reserve', 'invoke:agh.artifacts.publish'])
    expect(t.requests[1]).toEqual({
      publicationId,
      source: { kind: 'upload', upload },
      expectedRevision: 1,
      title: 'Notes',
      mediaType: 'text/markdown',
    })
  })

  it('returns an already ready publication on retry without rendering or publishing again', async () => {
    const t = attempt()
    t.grant('reserve', ready)
    expect(await t.run()).toEqual({ ok: true, value: { artifactId: 'artifact', version: 1 } })
    expect(t.renders()).toBe(0)
    expect(t.operations()).toEqual(['invoke:agh.artifacts.reserve'])
  })

  it.each([
    ['an ungranted reserve', undefined, 'incompatible', 'operation_not_supported'],
    [
      'a reply naming another publication',
      { ...reserved, publicationId: 'other' },
      'unknown_effect',
      'artifact_confirmation_unknown',
    ],
    [
      'a reply with another descriptor schema',
      { ...reserved, schema: RuntimeSchemaRefs.StandardToolOutput },
      'unknown_effect',
      'artifact_confirmation_unknown',
    ],
    [
      'a pending publication',
      { ...ready, state: 'pending-publish' },
      'unknown_effect',
      'artifact_publication_pending',
    ],
    [
      'a failed publication',
      {
        ...reserved,
        state: 'failed',
        failureRef: { authorityId: 'a', receiptId: 'r', digest: 'c'.repeat(64) },
      },
      'conflict',
      'artifact_publication_failed',
    ],
  ])('never renders after %s', async (_name, record, code, detailCode) => {
    const t = attempt()
    if (record) t.grant('reserve', record)
    expect(await t.run()).toMatchObject({ ok: false, error: { code, detailCode } })
    expect(t.renders()).toBe(0)
    expect(t.operations()).toEqual(['invoke:agh.artifacts.reserve'])
  })

  it('does not report success when publish stays pending or confirms other bytes', async () => {
    for (const [record, detailCode] of [
      [{ ...ready, state: 'pending-publish', pinId: null, blob: null }, 'artifact_publication_pending'],
      [{ ...ready, blob: { ...ready.blob, digest: 'd'.repeat(64) } }, 'artifact_published_digest_mismatch'],
    ] as const) {
      const t = attempt()
      t.grant('reserve', reserved)
      t.grant('publish', record)
      expect(await t.run({ upload, title: 'Notes' })).toMatchObject({
        ok: false,
        error: { code: 'unknown_effect', detailCode },
      })
    }
    const t = attempt()
    t.grant('reserve', reserved)
    expect(await t.run({ upload, title: '' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(t.operations()).toEqual(['invoke:agh.artifacts.reserve'])
  })

  it('stops before render on cancellation and maps render failures without staging', async () => {
    const cancelled = attempt()
    cancelled.grant('reserve', reserved, () => cancelled.abort.abort())
    expect(await cancelled.run()).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(cancelled.renders()).toBe(0)
    const thrown = attempt(() => {
      throw new Error('render bug')
    })
    thrown.grant('reserve', reserved)
    expect(await thrown.run()).toMatchObject({
      ok: false,
      error: { code: 'internal', detailCode: 'artifact_render_failed' },
    })
    const invalid = attempt(() => ({ title: 'Notes', mediaType: 'not a type', bytes: new Uint8Array(1) }))
    invalid.grant('reserve', reserved)
    expect(await invalid.run()).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', detailCode: 'artifact_draft_invalid' },
    })
    for (const t of [thrown, invalid]) expect(t.operations()).toEqual(['invoke:agh.artifacts.reserve'])
  })
})
