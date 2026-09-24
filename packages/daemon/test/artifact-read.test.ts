import { createHash } from 'node:crypto'
import { ARTIFACT_RECLAIMED_FAILURE } from '@agnes/host'
import { describe, expect, it, vi } from 'vitest'
import {
  type ArtifactReadAuthority,
  createAuthenticatedArtifactReadHandler,
  createTrustedSessionArtifactReadHandler,
} from '../src/local/artifact-read.js'
import { artifactMediaReadReply } from '../src/supervisor/artifact-read.js'

const bytes = new TextEncoder().encode('0123456789abcdef')
const ref = Object.freeze({
  sha256: createHash('sha256').update(bytes).digest('hex'),
  size: bytes.byteLength,
  mime: 'image/png',
})
const request = Object.freeze({ sessionId: 'session-a', laneId: 'lane-a', artifact: ref })
const caller = Object.freeze({
  principalId: 'owner-a',
  sessionId: 'session-a',
  laneId: 'lane-a',
  authKind: 'local' as const,
})

function setup(
  authorityValue: unknown = { sessionId: 'session-a', laneId: 'lane-a', ownerId: 'owner-a', artifact: ref },
) {
  const authority = {
    resolve: vi.fn(
      async (_session: string, _lane: string, _sha: string, _signal: AbortSignal) => authorityValue,
    ),
  }
  const artifacts = { get: vi.fn(async (_ref: unknown, _signal: AbortSignal) => bytes as unknown) }
  return {
    authority,
    artifacts,
    read: createAuthenticatedArtifactReadHandler({
      authority,
      artifacts,
      limits: { maxArtifactBytes: 1024, maxResponseBytes: 1024 },
      operationTimeoutMs: 1_000,
    }),
  }
}

describe('authenticated artifact read primitive', () => {
  it('binds authenticated owner, session and complete artifact identity before reading', async () => {
    const fixture = setup()
    const result = await fixture.read(request, caller)
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      artifact: ref,
      headers: {
        acceptRanges: 'bytes',
        contentLength: bytes.byteLength,
        contentType: 'image/png',
        etag: `"${ref.sha256}"`,
      },
    })
    if (!result.ok) throw new Error('expected artifact')
    expect([...result.body]).toEqual([...bytes])
    expect(result.body).not.toBe(bytes)
    expect(fixture.authority.resolve).toHaveBeenCalledWith(
      'session-a',
      'lane-a',
      ref.sha256,
      expect.any(AbortSignal),
    )
    expect(fixture.artifacts.get).toHaveBeenCalledWith(ref, expect.any(AbortSignal))
  })

  it('supports one bounded byte range and rejects invalid, multiple and oversized ranges', async () => {
    const fixture = setup()
    await expect(fixture.read({ ...request, range: 'bytes=2-5' }, caller)).resolves.toMatchObject({
      ok: true,
      status: 206,
      headers: { contentLength: 4, contentRange: `bytes 2-5/${bytes.byteLength}` },
      body: Uint8Array.from(bytes.slice(2, 6)),
    })
    await expect(fixture.read({ ...request, range: 'bytes=-3' }, caller)).resolves.toMatchObject({
      ok: true,
      status: 206,
      headers: { contentRange: `bytes 13-15/${bytes.byteLength}` },
    })
    for (const range of ['bytes=20-30', 'bytes=5-2', 'bytes=0-1,4-5', 'items=0-1', 'bytes=-0'])
      await expect(fixture.read({ ...request, range }, caller)).resolves.toMatchObject({
        ok: false,
        status: 416,
        code: 'range_not_satisfiable',
      })

    const bounded = createAuthenticatedArtifactReadHandler({
      authority: fixture.authority,
      artifacts: fixture.artifacts,
      limits: { maxArtifactBytes: 1024, maxResponseBytes: 4 },
      operationTimeoutMs: 1_000,
    })
    await expect(bounded(request, caller)).resolves.toMatchObject({ code: 'artifact_too_large' })
    await expect(bounded({ ...request, range: 'bytes=0-4' }, caller)).resolves.toMatchObject({
      code: 'artifact_too_large',
    })
    await expect(bounded({ ...request, range: 'bytes=0-3' }, caller)).resolves.toMatchObject({ ok: true })
  })

  it('denies cross-owner and identity drift before touching artifact bytes', async () => {
    const crossOwner = setup({ sessionId: 'session-a', laneId: 'lane-a', ownerId: 'owner-b', artifact: ref })
    await expect(crossOwner.read(request, caller)).resolves.toEqual({
      ok: false,
      status: 403,
      code: 'artifact_forbidden',
      message: 'Artifact access is denied.',
    })
    expect(crossOwner.artifacts.get).not.toHaveBeenCalled()

    const crossLane = setup({ sessionId: 'session-a', laneId: 'lane-b', ownerId: 'owner-a', artifact: ref })
    await expect(crossLane.read(request, caller)).resolves.toMatchObject({
      ok: false,
      status: 403,
      code: 'artifact_forbidden',
    })
    expect(crossLane.artifacts.get).not.toHaveBeenCalled()

    const drift = setup({
      sessionId: 'session-a',
      laneId: 'lane-a',
      ownerId: 'owner-a',
      artifact: { ...ref, mime: 'image/jpeg' },
    })
    await expect(drift.read(request, caller)).resolves.toMatchObject({
      ok: false,
      status: 409,
      code: 'artifact_identity_mismatch',
    })
    expect(drift.artifacts.get).not.toHaveBeenCalled()
  })

  it('rejects caller-selected session or lane before authority resolution', async () => {
    const fixture = setup()
    for (const scopedRequest of [
      { ...request, sessionId: 'session-b' },
      { ...request, laneId: 'lane-b' },
    ])
      await expect(fixture.read(scopedRequest, caller)).resolves.toMatchObject({
        ok: false,
        status: 403,
        code: 'artifact_forbidden',
      })
    expect(fixture.authority.resolve).not.toHaveBeenCalled()
    expect(fixture.artifacts.get).not.toHaveBeenCalled()
  })

  it('rejects path-like or hostile input without invoking getters or ports', async () => {
    const fixture = setup()
    const getter = vi.fn(() => ref.sha256)
    const artifact = { size: ref.size, mime: ref.mime }
    Object.defineProperty(artifact, 'sha256', { enumerable: true, get: getter })
    const samples: unknown[] = [
      { ...request, path: '/tmp/secret' },
      { ...request, artifact },
      { ...request, artifact: new Proxy(ref, {}) },
      Object.assign(Object.create({ inherited: true }), request),
    ]
    for (const sample of samples)
      await expect(fixture.read(sample, caller)).resolves.toMatchObject({
        ok: false,
        status: 400,
        code: 'invalid_request',
      })
    expect(getter).not.toHaveBeenCalled()
    expect(fixture.authority.resolve).not.toHaveBeenCalled()
    expect(fixture.artifacts.get).not.toHaveBeenCalled()
  })

  it('uses fixed errors for resolver/store failures and verifies returned bytes', async () => {
    const resolverFailure = setup()
    resolverFailure.authority.resolve.mockRejectedValueOnce(new Error('Bearer sk-resolver-secret'))
    const first = await resolverFailure.read(request, caller)
    expect(first).toMatchObject({ ok: false, code: 'artifact_unavailable' })
    expect(JSON.stringify(first)).not.toContain('secret')

    const storeFailure = setup()
    storeFailure.artifacts.get.mockRejectedValueOnce(new Error('Bearer sk-store-secret'))
    const second = await storeFailure.read(request, caller)
    expect(second).toMatchObject({ ok: false, code: 'artifact_unavailable' })
    expect(JSON.stringify(second)).not.toContain('secret')

    const corrupt = setup()
    corrupt.artifacts.get.mockResolvedValueOnce(new TextEncoder().encode('wrong bytes'))
    await expect(corrupt.read(request, caller)).resolves.toMatchObject({
      ok: false,
      status: 409,
      code: 'artifact_identity_mismatch',
    })
  })

  it('fails closed on unauthenticated, malformed authority and cancellation states', async () => {
    const fixture = setup()
    await expect(fixture.read(request, { principalId: 'owner-a' })).resolves.toMatchObject({
      ok: false,
      status: 401,
    })
    expect(fixture.authority.resolve).not.toHaveBeenCalled()

    const malformed = setup({
      sessionId: 'session-a',
      laneId: 'lane-a',
      ownerId: 'owner-a',
      artifact: ref,
      extra: true,
    } satisfies ArtifactReadAuthority & { extra: boolean })
    await expect(malformed.read(request, caller)).resolves.toMatchObject({
      ok: false,
      status: 404,
      code: 'artifact_not_found',
    })
    expect(malformed.artifacts.get).not.toHaveBeenCalled()

    const controller = new AbortController()
    controller.abort()
    await expect(fixture.read(request, caller, controller.signal)).resolves.toMatchObject({
      ok: false,
      code: 'artifact_unavailable',
    })
    expect(fixture.authority.resolve).not.toHaveBeenCalled()
  })

  it('snapshots constructor capabilities and rejects hostile configuration', async () => {
    const authority = {
      resolve: vi.fn(async () => ({
        sessionId: 'session-a',
        laneId: 'lane-a',
        ownerId: 'owner-a',
        artifact: ref,
      })),
    }
    const artifacts = { get: vi.fn(async () => bytes as unknown) }
    const read = createAuthenticatedArtifactReadHandler({
      authority,
      artifacts,
      limits: { maxArtifactBytes: 1024, maxResponseBytes: 1024 },
      operationTimeoutMs: 1_000,
    })
    authority.resolve = vi.fn(async () => {
      throw new Error('replacement secret')
    })
    artifacts.get = vi.fn(async () => {
      throw new Error('replacement secret')
    })
    await expect(read(request, caller)).resolves.toMatchObject({ ok: true })
    expect(authority.resolve).not.toHaveBeenCalled()
    expect(artifacts.get).not.toHaveBeenCalled()

    const getter = vi.fn(() => authority)
    const hostile = { artifacts, limits: { maxArtifactBytes: 1, maxResponseBytes: 1 }, operationTimeoutMs: 1 }
    Object.defineProperty(hostile, 'authority', { enumerable: true, get: getter })
    expect(() => createAuthenticatedArtifactReadHandler(hostile as never)).toThrow(TypeError)
    expect(getter).not.toHaveBeenCalled()
    for (const operationTimeoutMs of [0, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY])
      expect(() =>
        createAuthenticatedArtifactReadHandler({
          authority,
          artifacts,
          limits: { maxArtifactBytes: 1, maxResponseBytes: 1 },
          operationTimeoutMs,
        }),
      ).toThrow(TypeError)
  })

  it('aborts or times out pending authority and store operations without awaiting them', async () => {
    const authoritySignal = vi.fn<(signal: AbortSignal) => void>()
    const hangingAuthority = {
      resolve: vi.fn(
        async (_session: string, _lane: string, _sha: string, signal: AbortSignal) =>
          new Promise<never>(() => authoritySignal(signal)),
      ),
    }
    const unusedStore = { get: vi.fn(async () => bytes as unknown) }
    const readAuthority = createAuthenticatedArtifactReadHandler({
      authority: hangingAuthority,
      artifacts: unusedStore,
      limits: { maxArtifactBytes: 1024, maxResponseBytes: 1024 },
      operationTimeoutMs: 1_000,
    })
    const controller = new AbortController()
    const pending = readAuthority(request, caller, controller.signal)
    await vi.waitFor(() => expect(authoritySignal).toHaveBeenCalledOnce())
    controller.abort()
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'artifact_unavailable' })
    expect(authoritySignal.mock.calls[0]?.[0].aborted).toBe(true)

    const storeSignal = vi.fn<(signal: AbortSignal) => void>()
    const hangingStore = {
      get: vi.fn(async (_ref: unknown, signal: AbortSignal) => new Promise<never>(() => storeSignal(signal))),
    }
    const readStore = createAuthenticatedArtifactReadHandler({
      authority: {
        resolve: vi.fn(async () => ({
          sessionId: 'session-a',
          laneId: 'lane-a',
          ownerId: 'owner-a',
          artifact: ref,
        })),
      },
      artifacts: hangingStore,
      limits: { maxArtifactBytes: 1024, maxResponseBytes: 1024 },
      operationTimeoutMs: 10,
    })
    await expect(readStore(request, caller)).resolves.toMatchObject({
      ok: false,
      code: 'artifact_unavailable',
    })
    expect(storeSignal).toHaveBeenCalledOnce()
    expect(storeSignal.mock.calls[0]?.[0].aborted).toBe(true)
  })

  it('rejects hostile and oversized byte views before copying', async () => {
    class ByteSubclass extends Uint8Array {}
    const samples: unknown[] = [
      new Proxy(bytes, {}),
      new ByteSubclass(bytes),
      new Uint8Array(2 * 1024 * 1024),
    ]
    for (const sample of samples) {
      const fixture = setup()
      fixture.artifacts.get.mockResolvedValueOnce(sample)
      await expect(fixture.read(request, caller)).resolves.toMatchObject({
        ok: false,
        status: 409,
        code: 'artifact_identity_mismatch',
      })
    }

    const oversizedRef = Object.freeze({ ...ref, size: 1025 })
    const fixture = setup({
      sessionId: 'session-a',
      laneId: 'lane-a',
      ownerId: 'owner-a',
      artifact: oversizedRef,
    })
    await expect(
      fixture.read({ sessionId: 'session-a', laneId: 'lane-a', artifact: oversizedRef }, caller),
    ).resolves.toMatchObject({ ok: false, status: 413, code: 'artifact_too_large' })
    expect(fixture.artifacts.get).not.toHaveBeenCalled()
  })

  it('bounds numeric ranges and supports a zero-byte artifact without reading a range', async () => {
    const fixture = setup()
    await expect(
      fixture.read({ ...request, range: `bytes=0-${Number.MAX_SAFE_INTEGER}` }, caller),
    ).resolves.toMatchObject({ ok: true, status: 206, headers: { contentLength: bytes.byteLength } })
    await expect(
      fixture.read({ ...request, range: `bytes=${'1'.repeat(129)}-` }, caller),
    ).resolves.toMatchObject({
      ok: false,
      status: 400,
      code: 'invalid_request',
    })

    const empty = new Uint8Array()
    const emptyRef = Object.freeze({
      sha256: createHash('sha256').update(empty).digest('hex'),
      size: 0,
      mime: 'application/octet-stream',
    })
    const zero = setup({ sessionId: 'session-a', laneId: 'lane-a', ownerId: 'owner-a', artifact: emptyRef })
    zero.artifacts.get.mockResolvedValueOnce(empty)
    await expect(
      zero.read({ sessionId: 'session-a', laneId: 'lane-a', artifact: emptyRef }, caller),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      headers: { contentLength: 0 },
    })
    expect(zero.artifacts.get).toHaveBeenCalledOnce()

    const zeroRange = setup({
      sessionId: 'session-a',
      laneId: 'lane-a',
      ownerId: 'owner-a',
      artifact: emptyRef,
    })
    await expect(
      zeroRange.read(
        { sessionId: 'session-a', laneId: 'lane-a', artifact: emptyRef, range: 'bytes=0-' },
        caller,
      ),
    ).resolves.toMatchObject({ ok: false, status: 416, code: 'range_not_satisfiable' })
    expect(zeroRange.artifacts.get).not.toHaveBeenCalled()
  })
})

describe('reading a screenshot that retention reclaimed', () => {
  const owned = { sessionId: 'session-a', laneId: 'lane-a', ownerId: 'owner-a', artifact: ref }

  it('answers 410 only after the caller, binding and reference are authorized', async () => {
    const fixture = setup()
    fixture.artifacts.get.mockRejectedValue(ARTIFACT_RECLAIMED_FAILURE)
    await expect(fixture.read(request, caller)).resolves.toEqual({
      ok: false,
      status: 410,
      code: 'artifact_reclaimed',
      message: 'Artifact was removed by the retention policy.',
    })
    const refusals: Array<[unknown, unknown, number]> = [
      [null, request, 404],
      [{ ...owned, ownerId: 'owner-b' }, request, 403],
      [{ ...owned, laneId: 'lane-b' }, request, 403],
      [owned, { ...request, sessionId: 'session-b' }, 403],
    ]
    // The same answers whether the bytes are present or reclaimed: nothing tells them apart.
    for (const reclaimed of [false, true])
      for (const [authority, asked, status] of refusals) {
        const denied = setup(authority)
        if (reclaimed) denied.artifacts.get.mockRejectedValue(ARTIFACT_RECLAIMED_FAILURE)
        await expect(denied.read(asked, caller)).resolves.toMatchObject({ ok: false, status })
        expect(denied.artifacts.get).not.toHaveBeenCalled()
      }
  })

  it('keeps every other store failure, even one with the same message, a 500', async () => {
    const lookalike = setup()
    lookalike.artifacts.get.mockRejectedValue(new Error(ARTIFACT_RECLAIMED_FAILURE.message))
    await expect(lookalike.read(request, caller)).resolves.toMatchObject({
      ok: false,
      status: 500,
      code: 'artifact_unavailable',
    })
  })

  it('reports reclaimed to the trusted worker read and nothing for other failures', async () => {
    const trusted = (authorityValue: unknown, failure: unknown) => {
      const fixture = setup(authorityValue)
      fixture.artifacts.get.mockRejectedValue(failure)
      return createTrustedSessionArtifactReadHandler({
        authority: fixture.authority,
        artifacts: fixture.artifacts,
        limits: { maxArtifactBytes: 1024, maxResponseBytes: 1024 },
        operationTimeoutMs: 1_000,
      })({ sessionId: 'session-a', laneId: 'lane-a', ownerId: 'owner-a', sha256: ref.sha256 })
    }
    await expect(trusted(owned, ARTIFACT_RECLAIMED_FAILURE)).resolves.toEqual({ reclaimed: true })
    await expect(trusted(owned, new Error('disk'))).resolves.toBeUndefined()
    await expect(
      trusted({ ...owned, ownerId: 'owner-b' }, ARTIFACT_RECLAIMED_FAILURE),
    ).resolves.toBeUndefined()
  })

  it('replies to the worker with the digest and a reclaimed flag only', () => {
    expect(artifactMediaReadReply({ reclaimed: true }, ref.sha256)).toEqual({
      sha256: ref.sha256,
      reclaimed: true,
    })
    expect(artifactMediaReadReply(undefined, ref.sha256)).toBeUndefined()
  })
})
