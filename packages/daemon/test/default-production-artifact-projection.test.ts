import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PersistentArtifactReadAuthorityIndex } from '../src/local/artifact-read-authority.js'
import { SessionPrincipalOwnershipIndex } from '../src/storage/session-ownership.js'
import { composeDefaultProductionProjectedArtifactRead } from '../src/supervisor/artifact-read.js'
import { sqliteTables } from './sqlite-tables.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function header(sha256: string, mime = 'image/png') {
  return {
    seq: 4,
    ts: '2026-09-17T00:00:00.000Z',
    id: '01J6ZM2Q3R4S5T6V7W8X9Y0Z04',
    lane: 'main',
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
            mime,
            width: 8,
            height: 8,
            selected: true,
          },
        ],
      },
    },
  }
}

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agnes-default-artifact-projection-'))
  roots.push(dataDir)
  const bytes = new TextEncoder().encode('durable projection bytes')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const directory = join(dataDir, 'artifacts', 'sha256', sha256.slice(0, 2))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, sha256), bytes)

  // The artifact index deliberately owns a dedicated schema. Session ownership uses another
  // durable connection, matching the production capability split.
  const artifactTables = sqliteTables()
  const ownershipTables = sqliteTables()
  const artifactAuthority = new PersistentArtifactReadAuthorityIndex(
    artifactTables.table('artifact-read-authority'),
  )
  const ownershipTable = ownershipTables.table('session-principal-ownership')
  const sessionOwnership = new SessionPrincipalOwnershipIndex(ownershipTable)
  const composed = composeDefaultProductionProjectedArtifactRead(dataDir, {
    artifactAuthority,
    sessionOwnership,
    limits: { maxArtifactBytes: 1_024, maxResponseBytes: 1_024 },
    operationTimeoutMs: 1_000,
    scopeTimeoutMs: 1_000,
    readTimeoutMs: 1_000,
  })
  return {
    artifactTables,
    artifactAuthority,
    ownershipTables,
    ownershipTable,
    sessionOwnership,
    composed,
    artifact: Object.freeze({ sha256, size: bytes.byteLength, mime: 'image/png' }),
  }
}

describe('default durable production artifact projection', () => {
  it('projects only an active durable session owner and denies a cross-session principal', async () => {
    const item = await fixture()
    expect(item.sessionOwnership.bindNew('session-a', 'owner-a')).toBe(true)
    expect(item.sessionOwnership.activateNew('session-a', 'owner-a')).toBe(true)
    expect(item.sessionOwnership.bindNew('session-b', 'owner-b')).toBe(true)
    expect(item.sessionOwnership.activateNew('session-b', 'owner-b')).toBe(true)
    await item.composed.projection.observe(
      'session-a',
      header(item.artifact.sha256),
      new AbortController().signal,
    )

    const request = { sessionId: 'session-a', laneId: 'main', artifact: item.artifact }
    await expect(
      item.composed.rpc.read(request, {
        principalId: 'owner-a',
        authKind: 'local',
        sessionId: 'session-a',
        laneId: 'main',
      }),
    ).resolves.toMatchObject({ ok: true, status: 200 })
    await expect(
      item.composed.workerRead(
        { sessionId: 'session-a', laneId: 'main', ownerId: 'owner-a', sha256: item.artifact.sha256 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ ok: true, artifact: item.artifact })
    await expect(
      item.composed.workerRead(
        { sessionId: 'session-b', laneId: 'main', ownerId: 'owner-b', sha256: item.artifact.sha256 },
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined()
    await expect(
      item.composed.rpc.read(request, {
        principalId: 'owner-b',
        authKind: 'local',
        sessionId: 'session-b',
        laneId: 'main',
      }),
    ).resolves.toMatchObject({ ok: false })
    await item.artifactTables.close()
    await item.ownershipTables.close()
  })

  it('does not mint authority from a pending reservation or an aborted observation', async () => {
    const item = await fixture()
    expect(item.sessionOwnership.bindNew('session-a', 'owner-a')).toBe(true)
    const aborted = new AbortController()
    aborted.abort()
    await item.composed.projection.observe('session-a', header(item.artifact.sha256), aborted.signal)
    const request = { sessionId: 'session-a', laneId: 'main', artifact: item.artifact }
    await expect(
      item.composed.rpc.read(request, {
        principalId: 'owner-a',
        authKind: 'local',
        sessionId: 'session-a',
        laneId: 'main',
      }),
    ).resolves.toMatchObject({ ok: false, status: 404, code: 'artifact_not_found' })
    await item.artifactTables.close()
    await item.ownershipTables.close()
  })

  it('fails closed on a corrupt durable ownership row', async () => {
    const item = await fixture()
    expect(item.sessionOwnership.bindNew('session-a', 'owner-a')).toBe(true)
    expect(item.sessionOwnership.activateNew('session-a', 'owner-a')).toBe(true)
    item.ownershipTable.exec(
      "UPDATE session_principal_ownership SET reservation_state = 'corrupt' WHERE session_id = ?",
      ['session-a'],
    )
    await expect(
      item.composed.projection.observe(
        'session-a',
        header(item.artifact.sha256),
        new AbortController().signal,
      ),
    ).rejects.toThrow('artifact authority projection unavailable')
    await item.artifactTables.close()
    await item.ownershipTables.close()
  })

  it('rejects accessors, extra fields, implicit limits and non-durable capabilities', async () => {
    const item = await fixture()
    let touched = false
    const hostile = Object.defineProperty(
      {
        sessionOwnership: item.sessionOwnership,
        limits: { maxArtifactBytes: 1_024, maxResponseBytes: 1_024 },
        operationTimeoutMs: 1_000,
        scopeTimeoutMs: 1_000,
      },
      'artifactAuthority',
      {
        enumerable: true,
        get() {
          touched = true
          return {}
        },
      },
    )
    expect(() => composeDefaultProductionProjectedArtifactRead('/tmp', hostile as never)).toThrow(
      'default production artifact projection configuration is invalid',
    )
    expect(touched).toBe(false)
    expect(() =>
      composeDefaultProductionProjectedArtifactRead('/tmp', {
        artifactAuthority: {} as never,
        sessionOwnership: item.sessionOwnership,
        limits: { maxArtifactBytes: 1_024, maxResponseBytes: 1_024 },
        operationTimeoutMs: 1_000,
        scopeTimeoutMs: 1_000,
      }),
    ).toThrow('default production artifact projection configuration is invalid')
    expect(() =>
      composeDefaultProductionProjectedArtifactRead('/tmp', {
        artifactAuthority: item.artifactAuthority,
        sessionOwnership: item.sessionOwnership,
        operationTimeoutMs: 1_000,
        scopeTimeoutMs: 1_000,
      } as never),
    ).toThrow('default production artifact projection configuration is invalid')
    expect(() =>
      composeDefaultProductionProjectedArtifactRead('/tmp', {
        artifactAuthority: item.artifactAuthority,
        sessionOwnership: item.sessionOwnership,
        limits: { maxArtifactBytes: 1_024, maxResponseBytes: 1_024 },
        operationTimeoutMs: 1_000,
        scopeTimeoutMs: 1_000,
        extra: true,
      } as never),
    ).toThrow('default production artifact projection configuration is invalid')
    await item.artifactTables.close()
    await item.ownershipTables.close()
  })
})
