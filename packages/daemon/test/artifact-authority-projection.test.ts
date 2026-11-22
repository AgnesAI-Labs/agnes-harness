import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthenticatedArtifactReadHandler } from '@agnes/daemon-rpc/local/artifact-read'
import { createLocalArtifactReadStore } from '@agnes/host'
import { validateEvent } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { sqliteTables } from '../../daemon-foundation/test/sqlite-tables.js'
import { PersistentArtifactReadAuthorityIndex } from '../src/local/artifact-read-authority.js'
import { createArtifactAuthorityProjection } from '../src/supervisor/artifact-authority-projection.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agnes-artifact-projection-'))
  roots.push(dataDir)
  const bytes = new TextEncoder().encode('projected media root')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const directory = join(dataDir, 'artifacts', 'sha256', sha256.slice(0, 2))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, sha256), bytes)
  const store = createLocalArtifactReadStore({ dataDir, maxArtifactBytes: 1024 })
  const tables = sqliteTables()
  const index = new PersistentArtifactReadAuthorityIndex(tables.table('artifact-read-authority'))
  let principalId = 'owner-a'
  const writer = Object.freeze({
    append: index.append.bind(index),
    revoke: index.revoke.bind(index),
  })
  const inspector = Object.freeze({ inspect: store.inspect.bind(store) })
  const ownership = Object.freeze({ resolve: async () => ({ active: true, principalId }) })
  const makeProjection = (overrides: Partial<Parameters<typeof createArtifactAuthorityProjection>[0]> = {}) =>
    createArtifactAuthorityProjection({ writer, inspector, ownership, ...overrides })
  const projection = makeProjection()
  const event = (lane = 'main') => ({
    seq: 4,
    ts: '2026-09-17T00:00:00.000Z',
    id: '01J6ZM2Q3R4S5T6V7W8X9Y0Z04',
    lane,
    type: 'request/header',
    v: 1,
    actor: { id: 'owner-a', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    origin: 'system',
    trust: 'trusted',
    data: {
      derived_hash: 'a'.repeat(64),
      prompt_prefix_hash: 'b'.repeat(64),
      tool_schema_hash: 'c'.repeat(64),
      parser_version: '1',
      contract_id: null,
      model: 'm',
      envelopeNonce: 'd'.repeat(32),
      media: {
        version: 1,
        selectionOrder: [0],
        route: 'native-image',
        manifest: [
          {
            nodeSeq: 2,
            artifactUri: `artifact://${sha256}`,
            sha256,
            mime: 'image/png',
            width: 8,
            height: 8,
            selected: true,
          },
        ],
      },
    },
  })
  return {
    tables,
    index,
    projection,
    event,
    sha256,
    bytes,
    inspector,
    store,
    ownership,
    writer,
    makeProjection,
    setPrincipal: (value: string) => (principalId = value),
  }
}

describe('artifact authority ledger projection', () => {
  it.each(['header', 'registration'])(
    'derives exact size from trusted CAS bytes and isolates authenticated session lanes (%s)',
    async (source) => {
      const f = await fixture()
      const event =
        source === 'header'
          ? f.event()
          : {
              ...f.event(),
              type: 'x/core/artifact.registered',
              ignorable: true,
              data: { artifact: { sha256: f.sha256, size: f.bytes.byteLength, mime: 'image/png' } },
            }
      await f.projection.observe('session-a', event, new AbortController().signal)
      expect(f.index.resolve('session-a', 'main', f.sha256)).toMatchObject({
        ownerId: 'owner-a',
        artifact: { sha256: f.sha256, size: f.bytes.byteLength, mime: 'image/png' },
      })
      await expect(
        f.projection.scope.resolve(
          { principalId: 'owner-a', authKind: 'local', sessionId: 'session-a', laneId: 'main' },
          new AbortController().signal,
        ),
      ).resolves.toEqual({ sessionId: 'session-a', laneId: 'main' })
      for (const target of [
        { principalId: 'owner-b', authKind: 'local' as const, sessionId: 'session-a', laneId: 'main' },
        { principalId: 'owner-a', authKind: 'local' as const, sessionId: 'session-b', laneId: 'main' },
        { principalId: 'owner-a', authKind: 'local' as const, sessionId: 'session-a', laneId: 'other' },
      ])
        await expect(
          f.projection.scope.resolve(target, new AbortController().signal),
        ).resolves.toBeUndefined()
      await f.tables.close()
    },
  )

  it.each([
    ['tool:computer_use', 'untrusted', 'image/png'],
    ['tool:read', 'trusted', 'image/png'],
    ['tool:present', 'trusted', 'text/plain'],
    ['tool:document_read', 'untrusted', 'image/png'],
  ] as const)('projects a validated %s artifact before clients read it', async (origin, trust, mime) => {
    const f = await fixture()
    await f.projection.observe(
      'session-a',
      {
        seq: 3,
        ts: '2026-09-17T00:00:00.000Z',
        id: '01J6ZM2Q3R4S5T6V7W8X9Y0Z03',
        lane: 'main',
        type: 'tool/result',
        v: 1,
        actor: { id: 'owner-a', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        origin,
        trust,
        sourceEventSeqs: [2],
        data: {
          toolUseId: 'call-1',
          content: [
            {
              type: 'resource_link',
              name: 'image',
              uri: `artifact://${f.sha256}`,
              mimeType: mime,
            },
          ],
          isError: false,
          enforcement: { level: 'full', scope: [] },
          authz: { decisionId: 'n/a' },
        },
      },
      new AbortController().signal,
    )
    expect(f.index.resolve('session-a', 'main', f.sha256)).toMatchObject({
      ownerId: 'owner-a',
      artifact: { sha256: f.sha256, size: f.bytes.byteLength, mime },
    })
    await f.tables.close()
  })

  it.each([
    ['another tool', { origin: 'tool:other', trust: 'untrusted', isError: false }],
    ['a trusted tool result', { origin: 'tool:computer_use', trust: 'trusted', isError: false }],
    ['an error result', { origin: 'tool:computer_use', trust: 'untrusted', isError: true }],
    ['an untrusted session image result', { origin: 'tool:read', trust: 'untrusted', isError: false }],
    ['a trusted document image result', { origin: 'tool:document_read', trust: 'trusted', isError: false }],
    ['a failed document image result', { origin: 'tool:document_read', trust: 'untrusted', isError: true }],
    ['an untrusted deliverable result', { origin: 'tool:present', trust: 'untrusted', isError: false }],
    ['a failed deliverable result', { origin: 'tool:present', trust: 'trusted', isError: true }],
    ['a failed session image result', { origin: 'tool:read', trust: 'trusted', isError: true }],
  ])('does not project an image claimed by %s', async (_label, provenance) => {
    const f = await fixture()
    await f.projection.observe(
      'session-a',
      {
        seq: 3,
        ts: '2026-09-17T00:00:00.000Z',
        id: '01J6ZM2Q3R4S5T6V7W8X9Y0Z03',
        lane: 'main',
        type: 'tool/result',
        v: 1,
        actor: { id: 'owner-a', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        origin: provenance.origin,
        trust: provenance.trust,
        sourceEventSeqs: [2],
        data: {
          toolUseId: 'call-1',
          content: [
            {
              type: 'resource_link',
              name: 'image',
              uri: `artifact://${f.sha256}`,
              mimeType: 'image/png',
            },
          ],
          isError: provenance.isError,
          enforcement: { level: 'full', scope: [] },
          authz: { decisionId: 'n/a' },
        },
      },
      new AbortController().signal,
    )
    expect(f.index.resolve('session-a', 'main', f.sha256)).toBeUndefined()
    await f.tables.close()
  })

  it.each([
    ['an untrusted request header', { origin: 'system', trust: 'untrusted' }],
    ['a non-system request header', { origin: 'tool:computer_use', trust: 'trusted' }],
  ])('does not project media from %s', async (_label, provenance) => {
    const f = await fixture()
    await f.projection.observe(
      'session-a',
      { ...f.event(), origin: provenance.origin, trust: provenance.trust },
      new AbortController().signal,
    )
    expect(f.index.resolve('session-a', 'main', f.sha256)).toBeUndefined()
    await f.tables.close()
  })

  it('projects generic plugin registration before any tool result and refuses forged or mismatched registrations', async () => {
    const f = await fixture()
    const ref = { sha256: f.sha256, size: f.bytes.byteLength, mime: 'text/html' }
    const event = {
      ...f.event(),
      type: 'x/core/artifact.registered',
      ignorable: true,
      data: { artifact: ref },
    }
    for (const provenance of [
      { origin: 'ext:fixture/plugin', trust: 'trusted' },
      { origin: 'system', trust: 'untrusted' },
    ]) {
      await f.projection.observe('session-a', { ...event, ...provenance }, new AbortController().signal)
      expect(f.index.resolve('session-a', 'main', f.sha256)).toBeUndefined()
    }
    await f.projection.observe('session-a', event, new AbortController().signal)
    await expect(
      f.projection.observe(
        'session-a',
        { ...event, data: { artifact: { ...ref, size: ref.size - 1 } } },
        new AbortController().signal,
      ),
    ).rejects.toThrow()
    expect(f.index.resolve('session-a', 'main', f.sha256)?.artifact).toEqual(ref)
    const read = createAuthenticatedArtifactReadHandler({
      authority: { resolve: async (session, lane, hash) => f.index.resolve(session, lane, hash) },
      artifacts: { get: (ref, signal) => f.store.get(ref, signal) },
      limits: { maxArtifactBytes: 1024, maxResponseBytes: 1024 },
      operationTimeoutMs: 1000,
    })
    const response = await read(
      { sessionId: 'session-a', laneId: 'main', artifact: ref },
      { principalId: 'owner-a', sessionId: 'session-a', laneId: 'main', authKind: 'local' },
    )
    expect(response.ok).toBe(true)
    if (response.ok) expect(response.body).toEqual(f.bytes)
    // Cold replay consumes the durable registration with no present result or surface as a root.
    f.projection.resetSession('session-a')
    const cold = f.makeProjection()
    await cold.observe('session-a', event, new AbortController().signal)
    expect(f.index.resolve('session-a', 'main', f.sha256)?.artifact).toEqual(ref)
    const cancelled = new AbortController()
    cancelled.abort()
    await cold.observe('other', event, cancelled.signal)
    expect(f.index.resolve('other', 'main', f.sha256)).toBeUndefined()
    const { attachmentLink } = await import('@agnes/protocol')
    await cold.observe(
      'session-a',
      {
        ...event,
        type: 'user/message',
        origin: 'principal',
        data: { content: [attachmentLink(ref, 'original.html')] },
      },
      new AbortController().signal,
    )
    expect(f.index.resolve('session-a', 'main', f.sha256, ref.mime)?.artifact).toEqual(ref)
    await cold.observe(
      'session-a',
      {
        ...event,
        type: 'inbox',
        register: 'inbox',
        data: {
          items: Array.from({ length: 6 }, (_, index) => ({
            itemId: `queued-${index}`,
            target: 'next-turn',
            actor: event.actor,
            enqueuedAt: event.ts,
            content: Array.from({ length: 50 }, () =>
              attachmentLink({ ...ref, mime: 'text/plain' }, 'queued.txt'),
            ),
          })),
        },
      },
      new AbortController().signal,
    )
    expect(f.index.resolve('session-a', 'main', f.sha256, 'text/plain')?.artifact.mime).toBe('text/plain')
    await f.tables.close()
  })

  it('revokes on lane reset and denies immediately after ownership drift', async () => {
    const f = await fixture()
    await f.projection.observe('session-a', f.event(), new AbortController().signal)
    f.setPrincipal('owner-b')
    await expect(
      f.projection.scope.resolve(
        { principalId: 'owner-a', authKind: 'local', sessionId: 'session-a', laneId: 'main' },
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined()
    f.projection.revokeLane('session-a', 'main')
    expect(f.index.resolve('session-a', 'main', f.sha256)).toBeUndefined()
    await f.tables.close()
  })

  it('refuses ownership drift before appending a new root', async () => {
    const f = await fixture()
    await f.projection.observe('session-a', f.event(), new AbortController().signal)
    f.setPrincipal('owner-b')
    await expect(f.projection.observe('session-a', f.event(), new AbortController().signal)).rejects.toThrow(
      'artifact authority projection unavailable',
    )
    expect(f.index.resolve('session-a', 'main', f.sha256)?.ownerId).toBe('owner-a')
    await f.tables.close()
  })

  it('ignores non-media rows and refuses malformed roots without granting scope', async () => {
    const f = await fixture()
    const clearedInbox = { ...f.event(), type: 'inbox', register: 'inbox', data: null }
    expect(validateEvent(clearedInbox).ok).toBe(true)
    await expect(
      f.projection.observe('session-a', clearedInbox, new AbortController().signal),
    ).resolves.toBeUndefined()
    await f.projection.observe(
      'session-a',
      { ...f.event(), type: 'turn/end', data: { reason: 'completed' } },
      new AbortController().signal,
    )
    expect(f.index.resolve('session-a', 'main', f.sha256)).toBeUndefined()
    const malformed = f.event()
    const entry = malformed.data.media.manifest[0]
    if (!entry) throw new Error('fixture manifest entry missing')
    entry.artifactUri = `artifact://${'f'.repeat(64)}`
    await expect(
      f.projection.observe('session-a', malformed, new AbortController().signal),
    ).resolves.toBeUndefined()
    expect(f.index.resolve('session-a', 'main', f.sha256)).toBeUndefined()
    await f.tables.close()
  })

  it.each(['legacy', 'registration'] as const)(
    'fences %s projection that resumes after its lane was revoked',
    async (kind) => {
      const f = await fixture()
      let release: (() => void) | undefined
      let markStarted: (() => void) | undefined
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      const started = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      const projection = f.makeProjection({
        ownership: {
          resolve: async (sessionId, signal) => {
            markStarted?.()
            await pending
            return f.ownership.resolve()
          },
        },
      })
      const event =
        kind === 'legacy'
          ? f.event()
          : {
              ...f.event(),
              type: 'x/core/artifact.registered',
              data: { artifact: { sha256: f.sha256, size: f.bytes.byteLength, mime: 'image/png' } },
            }
      const observing = projection.observe('session-a', event, new AbortController().signal)
      await started
      projection.revokeLane('session-a', 'main')
      release?.()
      await expect(observing).rejects.toThrow('artifact authority projection unavailable')
      expect(f.index.resolve('session-a', 'main', f.sha256)).toBeUndefined()
      await f.tables.close()
    },
  )

  it('detaches every lane before reset revocation and continues after the first failure', async () => {
    const f = await fixture()
    let revokeCalls = 0
    const projection = f.makeProjection({
      writer: {
        append: f.writer.append,
        revoke: (authority, binding) => {
          revokeCalls += 1
          const result = f.writer.revoke(authority, binding)
          return revokeCalls === 1 ? { ok: false, code: 'storage_unavailable' as const } : result
        },
      },
    })
    await projection.observe('session-a', f.event('lane-a'), new AbortController().signal)
    await projection.observe('session-a', f.event('lane-b'), new AbortController().signal)
    expect(() => projection.resetSession('session-a')).toThrow('artifact authority revocation unavailable')
    expect(revokeCalls).toBe(2)
    for (const laneId of ['lane-a', 'lane-b'])
      await expect(
        projection.scope.resolve(
          { principalId: 'owner-a', authKind: 'local', sessionId: 'session-a', laneId },
          new AbortController().signal,
        ),
      ).resolves.toBeUndefined()
    await f.tables.close()
  })

  it('snapshots exact capabilities and redacts unknown credential-bearing failures', async () => {
    const f = await fixture()
    expect(() =>
      createArtifactAuthorityProjection(
        new Proxy(
          { writer: f.writer, inspector: f.inspector, ownership: f.ownership },
          {
            get: () => {
              throw new Error('Bearer constructor-secret')
            },
          },
        ),
      ),
    ).toThrow('artifact authority projection unavailable')

    const ownershipFailure = f.makeProjection({
      ownership: { resolve: async () => Promise.reject(new Error('Bearer ownership-secret')) },
    })
    await expect(
      ownershipFailure.observe('session-a', f.event(), new AbortController().signal),
    ).rejects.toThrow('artifact authority projection unavailable')

    const inspectorFailure = f.makeProjection({
      inspector: { inspect: async () => Promise.reject(new Error('Bearer inspector-secret')) },
    })
    await expect(
      inspectorFailure.observe('session-a', f.event(), new AbortController().signal),
    ).rejects.toThrow('artifact authority projection unavailable')

    const writerFailure = f.makeProjection({
      writer: {
        append: () => {
          throw new Error('Bearer append-secret')
        },
        revoke: () => {
          throw new Error('Bearer rollback-secret')
        },
      },
    })
    await expect(writerFailure.observe('session-a', f.event(), new AbortController().signal)).rejects.toThrow(
      'artifact authority projection unavailable',
    )
    await f.tables.close()
  })
})

describe('cold recorded artifact authority', () => {
  const target = {
    principalId: 'owner-a',
    authKind: 'local' as const,
    sessionId: 'session-a',
    laneId: 'main',
  }

  it.each([
    ['lane', 'before'],
    ['lane', 'during'],
    ['lane', 'after'],
    ['session', 'before'],
    ['session', 'during'],
    ['session', 'after'],
  ] as const)('keeps %s revocation effective %s a cold read', async (kind, when) => {
    const f = await fixture()
    try {
      let release!: () => void, started!: () => void
      const pending = new Promise<void>((r) => {
        release = r
      })
      const reading = new Promise<void>((r) => {
        started = r
      })
      const projection = f.makeProjection({
        history: {
          read: async () => {
            started()
            await pending
            return [f.event()]
          },
        },
      })
      const revoke = () =>
        kind === 'lane' ? projection.revokeLane('session-a', 'main') : projection.resetSession('session-a')
      if (when === 'before') {
        revoke()
        release()
      }
      const resolved = projection.scope.resolve(target, new AbortController().signal)
      if (when === 'during') {
        await reading
        revoke()
        release()
      }
      if (when === 'after') {
        release()
        await expect(resolved).resolves.toEqual({ sessionId: 'session-a', laneId: 'main' })
        revoke()
      } else await expect(resolved).resolves.toBeUndefined()
      await expect(projection.scope.resolve(target, new AbortController().signal)).resolves.toBeUndefined()
      expect(f.index.resolve('session-a', 'main', f.sha256)).toBeUndefined()
    } finally {
      await f.tables.close()
    }
  })

  it.each(['scan failure', 'cancelled scan'] as const)(
    'allows a healthy cold read after %s without reviving a reset scope',
    async (mode) => {
      const f = await fixture()
      try {
        let release!: () => void,
          started!: () => void,
          first = true
        const pending = new Promise<void>((r) => {
          release = r
        })
        const reading = new Promise<void>((r) => {
          started = r
        })
        const ac = new AbortController()
        const projection = f.makeProjection({
          history: {
            read: async () => {
              if (first) {
                first = false
                started()
                await pending
                if (mode === 'scan failure') throw new Error('private scan detail')
              }
              return [f.event()]
            },
          },
        })
        const failed = projection.scope.resolve(target, ac.signal)
        await reading
        if (mode === 'cancelled scan') {
          ac.abort()
          expect(f.index.resolve('session-a', 'main', f.sha256)).toBeUndefined()
        } else {
          release()
          await expect(failed).resolves.toBeUndefined()
          expect(f.index.resolve('session-a', 'main', f.sha256)).toBeUndefined()
        }
        // A cancelled adapter call may still be pending; it must not poison a healthy new request.
        await expect(projection.scope.resolve(target, new AbortController().signal)).resolves.toEqual({
          sessionId: 'session-a',
          laneId: 'main',
        })
        release()
        await expect(failed).resolves.toBeUndefined()
        projection.resetSession('session-a')
        await expect(projection.scope.resolve(target, new AbortController().signal)).resolves.toBeUndefined()
      } finally {
        await f.tables.close()
      }
    },
  )

  it.each(['wrong principal', 'unknown session', 'wrong lane', 'owner changed'] as const)(
    'refuses %s in recorded roots',
    async (scenario) => {
      const f = await fixture()
      try {
        const projection = f.makeProjection({
          ownership: {
            resolve: async (sessionId) => (sessionId === 'session-a' ? f.ownership.resolve() : undefined),
          },
          history: {
            read: async () => {
              if (scenario === 'owner changed') f.setPrincipal('owner-b')
              return [f.event(scenario === 'wrong lane' ? 'other' : 'main')]
            },
          },
        })
        const request = {
          ...target,
          ...(scenario === 'wrong principal' ? { principalId: 'other' } : {}),
          ...(scenario === 'unknown session' ? { sessionId: 'unknown' } : {}),
        }
        await expect(projection.scope.resolve(request, new AbortController().signal)).resolves.toBeUndefined()
        expect(f.index.resolve('session-a', 'main', f.sha256)).toBeUndefined()
        expect(f.index.resolve('unknown', 'main', f.sha256)).toBeUndefined()
      } finally {
        await f.tables.close()
      }
    },
  )

  it('retains a concurrent live registration while older recorded roots are loading', async () => {
    const f = await fixture()
    try {
      let release!: () => void, started!: () => void
      const pending = new Promise<void>((r) => {
        release = r
      })
      const reading = new Promise<void>((r) => {
        started = r
      })
      const projection = f.makeProjection({
        history: {
          read: async () => {
            started()
            await pending
            return [f.event()]
          },
        },
      })
      const resolved = projection.scope.resolve(target, new AbortController().signal)
      await reading
      const live = { sha256: 'a'.repeat(64), size: 1, mime: 'text/plain' }
      await projection.observe(
        'session-a',
        { ...f.event(), type: 'x/core/artifact.registered', ignorable: true, data: { artifact: live } },
        new AbortController().signal,
      )
      release()
      await expect(resolved).resolves.toEqual({ sessionId: 'session-a', laneId: 'main' })
      expect(f.index.resolve('session-a', 'main', f.sha256)).toBeDefined()
      expect(f.index.resolve('session-a', 'main', live.sha256)).toBeDefined()
      projection.resetSession('session-a')
      expect(f.index.resolve('session-a', 'main', f.sha256)).toBeUndefined()
      expect(f.index.resolve('session-a', 'main', live.sha256)).toBeUndefined()
    } finally {
      await f.tables.close()
    }
  })

  it('reconstructs cold read authority after normal worker detachment while fencing stale in-flight cold reads', async () => {
    const f = await fixture()
    try {
      let releaseFirst!: () => void,
        firstStarted!: () => void,
        calls = 0
      const firstGate = new Promise<void>((r) => {
        releaseFirst = r
      })
      const started = new Promise<void>((r) => {
        firstStarted = r
      })
      const projection = f.makeProjection({
        history: {
          read: async () => {
            calls += 1
            if (calls === 1) {
              firstStarted()
              await firstGate
            }
            return [f.event()]
          },
        },
      })
      const inflight = projection.scope.resolve(target, new AbortController().signal)
      await started
      // Worker lifecycle detachment fences the old epoch without permanently banning future cold reads,
      // and a reader arriving immediately starts a fresh epoch-scoped cold load instead of joining the stale one.
      projection.detachSession('session-a')
      const freshAfterDetach = projection.scope.resolve(target, new AbortController().signal)
      await expect(freshAfterDetach).resolves.toEqual({
        sessionId: 'session-a',
        laneId: 'main',
      })
      expect(calls).toBe(2)
      releaseFirst()
      await expect(inflight).resolves.toBeUndefined()
      expect(f.index.resolve('session-a', 'main', f.sha256)).toBeDefined()

      projection.detachSession('session-a')
      expect(f.index.resolve('session-a', 'main', f.sha256)).toBeUndefined()
      await expect(projection.scope.resolve(target, new AbortController().signal)).resolves.toEqual({
        sessionId: 'session-a',
        laneId: 'main',
      })
      expect(f.index.resolve('session-a', 'main', f.sha256)).toBeDefined()

      // Explicit revocation still permanently denies cold reads until a fresh live observe.
      projection.resetSession('session-a')
      await expect(projection.scope.resolve(target, new AbortController().signal)).resolves.toBeUndefined()
    } finally {
      await f.tables.close()
    }
  })

  it.each(['first', 'second'] as const)(
    'isolates concurrent cold-read callers when the %s caller cancels',
    async (cancelledCaller) => {
      const f = await fixture()
      try {
        let release!: () => void,
          started!: () => void,
          scans = 0
        const gate = new Promise<void>((r) => {
          release = r
        })
        const reading = new Promise<void>((r) => {
          started = r
        })
        const projection = f.makeProjection({
          history: {
            read: async () => {
              scans += 1
              started()
              await gate
              return [f.event()]
            },
          },
        })
        const ac1 = new AbortController()
        const ac2 = new AbortController()
        const first = projection.scope.resolve(target, ac1.signal)
        await reading
        const second = projection.scope.resolve(target, ac2.signal)
        await Promise.resolve()
        if (cancelledCaller === 'first') {
          ac1.abort()
          await expect(first).resolves.toBeUndefined()
          release()
          await expect(second).resolves.toEqual({ sessionId: 'session-a', laneId: 'main' })
        } else {
          ac2.abort()
          await expect(second).resolves.toBeUndefined()
          release()
          await expect(first).resolves.toEqual({ sessionId: 'session-a', laneId: 'main' })
        }
        expect(scans).toBe(1)
      } finally {
        await f.tables.close()
      }
    },
  )
})
