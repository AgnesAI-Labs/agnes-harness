import { createHash } from 'node:crypto'
import { defineGeneratedAuthorSchema } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import {
  encodePublicationPayload,
  publicationRequiredDigests,
  publicationSchemaRefs,
  publicationSourceDigest,
  readPublicationDataRef,
  readPublicationPayload,
  verifyPublicationContents,
} from '../../src/runtime/maintenance/publication-codecs.js'
import {
  appliedSourceSource,
  currentHeadSource,
  releaseRouteSource,
  releaseSnapshotSource,
} from '../../src/runtime/maintenance/publication-schema-sources.js'
import { publicationCodecFixture } from './fixtures/publication-codecs.js'

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
describe('publication source-bound data codecs', () => {
  it('keeps four generated schema identities fixed and disjoint', () => {
    expect(Object.values(publicationSchemaRefs).map((row) => row.digest)).toEqual([
      '0dc6762698ea0ce723169a4e5e0ba1ccdf6a74b87ab29a52d44f8dfd9f9f71b3',
      'b86900746f65ef2015ef2109b3661acb434cbb8ec912aef0da81880f01a32978',
      '9fa1171843fc3d6779e77ab80d391aeab576477315a6dfaf731ac455354ce66d',
      'a991cfec3680ff3a5aa56724c39f3ca118115e2652270d4f2e7c3f1261b23adf',
    ])
    for (const source of [
      currentHeadSource,
      releaseRouteSource,
      releaseSnapshotSource,
      appliedSourceSource,
    ]) {
      expect(defineGeneratedAuthorSchema(source).ref).toEqual(
        Object.values(publicationSchemaRefs).find((ref) => ref.typeId === source.typeId),
      )
      expect(Object.isFrozen(source.document)).toBe(true)
    }
  })
  it('decodes complete official bodies and retained bytes without asserting an issuer or commit', () => {
    const f = publicationCodecFixture()
    const decoded = verifyPublicationContents(f.source, f.request, f.contents)
    expect(decoded.release).toEqual(f.release)
    expect(decoded.binding).toEqual(f.binding)
    expect(decoded.configuration.status).toBe('candidate')
    expect(decoded.request.outbox).toEqual([])
    expect(decoded.source.requiredDigests).toContain(f.source.issuerCodeDigest)
    expect(decoded.source.requiredDigests).toContain(f.source.planDigest)
    const encoded = encodePublicationPayload('source', f.source)
    expect(readPublicationDataRef('source', encoded)).toEqual(f.source)
    expect(publicationSourceDigest(f.source)).toBe(
      sha(jcs({ schema: publicationSchemaRefs.source, payload: f.source })),
    )
    expect(
      verifyPublicationContents(structuredClone(f.source), structuredClone(f.request), f.contents).source,
    ).toEqual(f.source)
  })
  it('rejects forged full refs even when their JSON values remain valid', () => {
    const f = publicationCodecFixture()
    const ref = encodePublicationPayload('source', f.source)
    if (ref.kind !== 'inline') throw new Error('inline expected')
    for (const altered of [
      { ...ref, digest: '0'.repeat(64) },
      { ...ref, bytes: ref.bytes + 1 },
      { ...ref, schema: { ...ref.schema, revision: 2 } },
      { ...ref, schema: { ...ref.schema, digest: '0'.repeat(64) } },
    ])
      expect(() => readPublicationDataRef('source', altered)).toThrow()
    expect(() => readPublicationDataRef('head', ref)).toThrow()
  })
  it('rejects unknown fields, accessors, noncanonical JSON and incorrect inner types', () => {
    const f = publicationCodecFixture()
    let getterCalls = 0
    const getter = Object.defineProperty({}, 'formatVersion', {
      enumerable: true,
      get: () => {
        getterCalls++
        throw new Error('getter ran')
      },
    })
    expect(() => readPublicationPayload('source', getter)).toThrow()
    expect(getterCalls).toBe(0)
    expect(() => readPublicationPayload('source', { ...f.source, extra: true })).toThrow()
    expect(() =>
      readPublicationPayload('source', { ...f.source, scopeJson: '{ "kind":"runtime" }' }),
    ).toThrow()
    expect(() =>
      readPublicationPayload('source', { ...f.source, producerJson: jcs({ bindingId: 'only-a-string' }) }),
    ).toThrow()
    expect(() =>
      readPublicationPayload('route', {
        routeId: '',
        activeReleaseSetId: 'r',
        authorityEpoch: -0,
        cutoverId: 'c',
      }),
    ).toThrow()
  })
  it('enforces the original shortest deadline and forbids unavailable protected sources', () => {
    const f = publicationCodecFixture()
    expect(() =>
      readPublicationPayload('source', { ...f.source, qualifiedUntil: f.source.contextDeadline }),
    ).toThrow()
    expect(() =>
      readPublicationPayload('source', { ...f.source, observedAt: f.source.qualifiedUntil }),
    ).toThrow()
    expect(() => readPublicationPayload('source', { ...f.source, protectedUntil: null })).toThrow()
    expect(() =>
      readPublicationPayload('source', { ...f.source, contextDeadline: '2026-10-04T00:00:00Z' }),
    ).toThrow()
  })
  it('refuses duplicate logical roles, changed bytes, missing and extra retained content', () => {
    const f = publicationCodecFixture()
    expect(() =>
      readPublicationPayload('source', { ...f.source, content: [...f.source.content, f.source.content[0]] }),
    ).toThrow()
    expect(() => verifyPublicationContents(f.source, f.request, f.contents.slice(1))).toThrow()
    const changed = f.contents.map((row, i) =>
      i === 0 ? { ...row, body: Buffer.from('altered original bytes') } : row,
    )
    expect(() => verifyPublicationContents(f.source, f.request, changed)).toThrow()
    const extra = Buffer.from('{}')
    expect(() =>
      verifyPublicationContents(f.source, f.request, [
        ...f.contents,
        { kind: 'bytes', digest: sha(extra), body: extra },
      ]),
    ).toThrow()
  })
  it('rejects a forged original reference location', () => {
    const f = publicationCodecFixture()
    const row = f.source.content.find((item) => item.role === 'referenced-json')
    if (!row) throw new Error('reference missing')
    row.path = '/forged'
    f.source.content.sort((a, b) =>
      Buffer.compare(
        Buffer.from(jcs([a.role, a.packageId, a.path])),
        Buffer.from(jcs([b.role, b.packageId, b.path])),
      ),
    )
    expect(() => verifyPublicationContents(f.source, f.request, f.contents)).toThrow()
  })
  it('requires every repeated reference occurrence and authentic protected contents', () => {
    const f = publicationCodecFixture()
    const occurrences = f.source.content.filter((row) => row.role === 'referenced-json')
    const repeated = occurrences.find((row) =>
      occurrences.some((other) => other !== row && other.digest === row.digest),
    )
    if (!repeated) throw new Error('Original repeated reference missing')
    expect(() =>
      verifyPublicationContents(
        { ...f.source, content: f.source.content.filter((row) => row !== repeated) },
        f.request,
        f.contents,
      ),
    ).toThrow()
    const lock = f.source.content.find((row) => row.role === 'protected-lock')
    const original = f.contents.find((row) => row.kind === lock?.kind && row.digest === lock?.digest)
    if (!lock || !original) throw new Error('Original lock missing')
    const payload = JSON.parse(Buffer.from(original.body).toString())
    const body = Buffer.from(jcs({ ...payload, contents: [{ fake: 'unretained' }] }))
    const oldDigest = lock.digest
    lock.digest = sha(body)
    lock.bytes = body.length
    const contents = f.contents.map((row) =>
      row.digest === oldDigest ? { ...row, digest: lock.digest, body } : row,
    )
    f.source.requiredDigests = [...publicationRequiredDigests(f.source, contents)]
    expect(() => verifyPublicationContents(f.source, f.request, contents)).toThrow()
  })
  it('requires declared package schemas to retain the original source file', () => {
    const f = publicationCodecFixture()
    const manifestRow = f.source.content.find((row) => row.role === 'package-manifest')
    const body = f.contents.find((row) => row.digest === manifestRow?.digest)
    if (!body) throw new Error('Manifest missing')
    const schema = JSON.parse(Buffer.from(body.body).toString()).schemas[0].ref
    const missing = f.source.content.find(
      (row) => row.role === 'schema-source' && row.schemaJson === jcs(schema),
    )
    if (!missing) throw new Error('Declared source missing')
    expect(() =>
      verifyPublicationContents(
        { ...f.source, content: f.source.content.filter((row) => row !== missing) },
        f.request,
        f.contents,
      ),
    ).toThrow()
  })
  it('rechecks official nested configuration after an attacker recomputes its content digest', () => {
    const f = publicationCodecFixture()
    const row = f.source.content.find((item) => item.role === 'config-result')
    if (!row) throw new Error('config row missing')
    const bytes = f.contents.find((item) => item.digest === row.digest)
    if (!bytes) throw new Error('bytes missing')
    const raw = JSON.parse(Buffer.from(bytes.body).toString())
    const altered = Buffer.from(jcs({ ...raw, unexpected: true }))
    const previous = row.digest
    row.digest = sha(altered)
    row.bytes = altered.length
    const changed = f.contents.map((item) =>
      item.digest === previous ? { ...item, digest: row.digest, body: altered } : item,
    )
    f.source.requiredDigests = [...publicationRequiredDigests(f.source, changed)]
    expect(() => verifyPublicationContents(f.source, f.request, changed)).toThrow()
  })
  it('checks full member headers, complete fingerprints and exact cross-member links', () => {
    const f = publicationCodecFixture()
    const bad = structuredClone(f.request)
    const route = bad.mutations[1]
    if (!route) throw new Error('route missing')
    route.next.revision = 2
    expect(() => verifyPublicationContents(f.source, bad, f.contents)).toThrow()
    const moved = structuredClone(f.request)
    moved.mutations.reverse()
    expect(() => verifyPublicationContents(f.source, moved, f.contents)).toThrow()
    expect(() =>
      verifyPublicationContents(
        { ...f.source, memberFingerprints: ['0'.repeat(64), ...f.source.memberFingerprints.slice(1)] },
        f.request,
        f.contents,
      ),
    ).toThrow()
    expect(() =>
      verifyPublicationContents(
        {
          ...f.source,
          stateAuthorityJson: jcs({ authorityId: 'other', tenantId: 'tenant', authorityEpoch: 1 }),
        },
        f.request,
        f.contents,
      ),
    ).toThrow()
  })
  it('requires the exact complete inventory, excluding association hashes', () => {
    const f = publicationCodecFixture()
    expect(() =>
      verifyPublicationContents(
        { ...f.source, requiredDigests: f.source.requiredDigests.slice(1) },
        f.request,
        f.contents,
      ),
    ).toThrow()
    const extra = [...new Set([...f.source.requiredDigests, '0'.repeat(64)])].sort()
    expect(() =>
      verifyPublicationContents({ ...f.source, requiredDigests: extra }, f.request, f.contents),
    ).toThrow()
    expect(f.source.requiredDigests).not.toContain(publicationSourceDigest(f.source))
  })
  it('keeps inline and canonical string budgets strict', () => {
    const f = publicationCodecFixture()
    expect(() =>
      readPublicationPayload('release', { canonicalJson: ' '.repeat(60001), contentDigest: '0'.repeat(64) }),
    ).toThrow()
    expect(() =>
      readPublicationPayload('source', { ...f.source, content: Array(129).fill(f.source.content[0]) }),
    ).toThrow()
    const oversized = Array.from({ length: 128 }, (_, index) => ({
      role: 'package-file',
      kind: 'bytes',
      digest: f.source.issuerCodeDigest,
      bytes: 0,
      packageId: null,
      path: String(index).padStart(3, '0') + 'a'.repeat(1021),
      schemaJson: null,
    }))
    expect(() => readPublicationPayload('source', { ...f.source, content: oversized })).toThrow()
  })
})
