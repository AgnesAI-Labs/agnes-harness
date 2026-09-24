import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ARTIFACT_READ_RPC_MAX_BYTES } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createArtifactReadAuthorityPort,
  PersistentArtifactReadAuthorityIndex,
} from '../src/local/artifact-read-authority.js'
import {
  composeProductionArtifactRead,
  composeProductionProjectedArtifactRead,
} from '../src/supervisor/artifact-read.js'
import { sqliteTables } from './sqlite-tables.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agnes-production-artifact-read-'))
  roots.push(dataDir)
  const bytes = new TextEncoder().encode('real production artifact')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const directory = join(dataDir, 'artifacts', 'sha256', sha256.slice(0, 2))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, sha256), bytes)
  const artifact = Object.freeze({ sha256, size: bytes.byteLength, mime: 'image/png' })
  const authority = Object.freeze({
    resolve: vi.fn(async () =>
      Object.freeze({ sessionId: 'session-a', laneId: 'main', ownerId: 'local', artifact }),
    ),
  })
  const scope = Object.freeze({
    resolve: vi.fn(async () => Object.freeze({ sessionId: 'session-a', laneId: 'main' })),
  })
  return { dataDir, bytes, artifact, authority, scope }
}

describe('production artifact read composition', () => {
  it('uses projected ledger authority as the production RPC scope', async () => {
    const item = await fixture()
    const tables = sqliteTables()
    const index = new PersistentArtifactReadAuthorityIndex(tables.table('artifact-read-authority'))
    const projected = composeProductionProjectedArtifactRead(item.dataDir, {
      authority: createArtifactReadAuthorityPort(index),
      writer: Object.freeze({ append: index.append.bind(index), revoke: index.revoke.bind(index) }),
      ownership: Object.freeze({
        resolve: async () => Object.freeze({ active: true, principalId: 'local' }),
      }),
      limits: { maxArtifactBytes: 1024, maxResponseBytes: 1024 },
      operationTimeoutMs: 1_000,
      scopeTimeoutMs: 1_000,
    })
    const request = { sessionId: 'session-a', laneId: 'main', artifact: item.artifact }
    const caller = {
      principalId: 'local',
      authKind: 'local' as const,
      sessionId: 'session-a',
      laneId: 'main',
    }
    await expect(projected.rpc.read(request, caller)).resolves.toMatchObject({
      ok: false,
      status: 404,
      code: 'artifact_not_found',
    })
    await projected.projection.observe(
      'session-a',
      {
        seq: 4,
        ts: '2026-09-17T00:00:00.000Z',
        id: '01J6ZM2Q3R4S5T6V7W8X9Y0Z04',
        lane: 'main',
        type: 'request/header',
        v: 1,
        actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
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
                artifactUri: `artifact://${item.artifact.sha256}`,
                sha256: item.artifact.sha256,
                mime: item.artifact.mime,
                width: 8,
                height: 8,
                selected: true,
              },
            ],
          },
        },
      },
      new AbortController().signal,
    )
    await expect(projected.rpc.read(request, caller)).resolves.toMatchObject({ ok: true, status: 200 })
    await tables.close()
  })

  it('fits the authenticated handler to real content-addressed bytes', async () => {
    const item = await fixture()
    const composed = composeProductionArtifactRead(item.dataDir, {
      authority: item.authority,
      scope: item.scope,
      limits: { maxArtifactBytes: 1024, maxResponseBytes: 1024 },
      operationTimeoutMs: 1_000,
      scopeTimeoutMs: 1_000,
    })
    const result = await composed.read(
      { sessionId: 'session-a', laneId: 'main', artifact: item.artifact },
      { principalId: 'local', authKind: 'local', sessionId: 'session-a', laneId: 'main' },
      new AbortController().signal,
    )
    expect(result).toMatchObject({ ok: true, status: 200, artifact: item.artifact })
    expect((result as { body: Uint8Array }).body).toEqual(item.bytes)
  })

  it('fails closed before byte access when durable ownership denies the digest', async () => {
    const item = await fixture()
    const authority = Object.freeze({ resolve: vi.fn(async () => undefined) })
    const composed = composeProductionArtifactRead(item.dataDir, {
      authority,
      scope: item.scope,
      limits: { maxArtifactBytes: 1024, maxResponseBytes: 1024 },
      operationTimeoutMs: 1_000,
      scopeTimeoutMs: 1_000,
    })
    await expect(
      composed.read(
        { sessionId: 'session-a', laneId: 'main', artifact: item.artifact },
        { principalId: 'local', authKind: 'local', sessionId: 'session-a', laneId: 'main' },
      ),
    ).resolves.toMatchObject({ ok: false, status: 404, code: 'artifact_not_found' })
    expect(authority.resolve).toHaveBeenCalledOnce()
  })

  it('rejects accessor-bearing authority configuration without evaluating it', async () => {
    const item = await fixture()
    let touched = false
    const hostile = Object.defineProperty(
      {
        scope: item.scope,
        limits: { maxArtifactBytes: 1024, maxResponseBytes: 1024 },
        operationTimeoutMs: 1_000,
        scopeTimeoutMs: 1_000,
      },
      'authority',
      {
        enumerable: true,
        get() {
          touched = true
          return item.authority
        },
      },
    )
    expect(() => composeProductionArtifactRead(item.dataDir, hostile as never)).toThrow(
      'production artifact read configuration is invalid',
    )
    expect(touched).toBe(false)
  })

  it('allows large artifacts while keeping each public RPC response below its frame ceiling', async () => {
    const item = await fixture()
    expect(() =>
      composeProductionArtifactRead(item.dataDir, {
        authority: item.authority,
        scope: item.scope,
        limits: {
          maxArtifactBytes: ARTIFACT_READ_RPC_MAX_BYTES + 1,
          maxResponseBytes: ARTIFACT_READ_RPC_MAX_BYTES,
        },
        operationTimeoutMs: 1_000,
        scopeTimeoutMs: 1_000,
      }),
    ).not.toThrow()
  })
})
