import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalArtifactReadStore } from '@agnes/host'
import { afterEach, describe, expect, it } from 'vitest'
import { PersistentArtifactReadAuthorityIndex } from '../src/local/artifact-read-authority.js'
import { createArtifactAuthorityProjection } from '../src/supervisor/artifact-authority-projection.js'
import { sqliteTables } from './sqlite-tables.js'

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
    ownership,
    writer,
    makeProjection,
    setPrincipal: (value: string) => (principalId = value),
  }
}

describe('artifact authority ledger projection', () => {
  it('derives exact size from trusted CAS bytes and isolates authenticated session lanes', async () => {
    const f = await fixture()
    await f.projection.observe('session-a', f.event(), new AbortController().signal)
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
      await expect(f.projection.scope.resolve(target, new AbortController().signal)).resolves.toBeUndefined()
    await f.tables.close()
  })

  it('projects a validated tool-result image before request-media preflight needs to read it', async () => {
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
        origin: 'tool:computer_use',
        trust: 'untrusted',
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
          isError: false,
          enforcement: { level: 'full', scope: [] },
          authz: { decisionId: 'n/a' },
        },
      },
      new AbortController().signal,
    )
    expect(f.index.resolve('session-a', 'main', f.sha256)).toMatchObject({
      ownerId: 'owner-a',
      artifact: { sha256: f.sha256, size: f.bytes.byteLength, mime: 'image/png' },
    })
    await f.tables.close()
  })

  it.each([
    ['another tool', { origin: 'tool:other', trust: 'untrusted', isError: false }],
    ['a trusted tool result', { origin: 'tool:computer_use', trust: 'trusted', isError: false }],
    ['an error result', { origin: 'tool:computer_use', trust: 'untrusted', isError: true }],
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

  it('fences an observe that resumes after its lane was revoked', async () => {
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
      inspector: {
        inspect: async (identity, signal) => {
          markStarted?.()
          await pending
          return f.inspector.inspect(identity, signal)
        },
      },
    })
    const observing = projection.observe('session-a', f.event(), new AbortController().signal)
    await started
    projection.revokeLane('session-a', 'main')
    release?.()
    await expect(observing).rejects.toThrow('artifact authority projection unavailable')
    expect(f.index.resolve('session-a', 'main', f.sha256)).toBeUndefined()
    await f.tables.close()
  })

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
