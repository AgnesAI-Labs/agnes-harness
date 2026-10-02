import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import { type InteractionRecord, type JsonValue, validateRuntime } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createInteractionReads,
  type InteractionReadPorts,
  type RuntimeInteractionReadOwner,
} from '../src/runtime/state/interaction-read.js'
import { refuse } from '../src/runtime/state/refusal.js'

// Restricted SQLite source fixture tests the query ports; it is not the production State adapter.
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
const scope = {
  kind: 'session' as const,
  installationId: 'installation',
  runtimeId: 'runtime',
  workspaceId: 'workspace',
  sessionId: 'session',
}
const context = () =>
  ({ signal: new AbortController().signal, deadline: '2030-01-01T00:00:00.000Z' }) as CallContext
const digest = (value: unknown) => createHash('sha256').update(jcs(value)).digest('hex')
function question(id: string): InteractionRecord {
  const record = {
    interactionId: id,
    owner: { runId: 'run', actionId: 'action' },
    version: 1,
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    status: 'pending',
    terminationReason: null,
    resolution: null,
    request: {
      kind: 'question',
      title: 'Question',
      body: 'Answer',
      fields: [],
      allowedResponders: ['human'],
      expiresAt: '2030-01-01T00:00:00.000Z',
      idempotencyKey: id,
      answerSchema: {
        typeId: 'agh.test/interaction-answer@1',
        revision: 1,
        digest: digest({ $id: 'agh.test/interaction-answer@1', type: 'string' }),
      },
    },
  }
  const checked = validateRuntime('InteractionRecord', record)
  if (!checked.ok) throw Error('invalid fixture question')
  return checked.value
}
function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  db.exec(
    'CREATE TABLE versions(id TEXT,version INTEGER,body TEXT,hash TEXT, PRIMARY KEY(id,version)); CREATE TABLE responses(id TEXT PRIMARY KEY, body TEXT, admission TEXT);',
  )
  let revoked = false,
    complete = true,
    acknowledged = false,
    now = Date.parse('2026-10-02T00:00:00.000Z'),
    readerBinding = 'reader'
  let atReturn: (() => void) | undefined
  const owner: RuntimeInteractionReadOwner = {
    owner: {
      authority: { authorityId: 'interaction', tenantId: 'tenant', authorityEpoch: 1 },
      ownerBinding: {
        bindingId: 'interaction-binding',
        contract: 'agh.interaction',
        logicalName: 'default',
        providerId: 'provider',
      },
      scope: {
        kind: 'session',
        installationId: 'installation',
        runtimeId: 'runtime',
        workspaceId: 'workspace',
        sessionId: 'session',
      },
    },
    cursorKey: new Uint8Array(32).fill(9),
    now: () => now,
    current() {
      if (revoked) refuse('denied', 'reader', 'reader revoked')
      return { binding: readerBinding, scope }
    },
  }
  const put = (value: InteractionRecord) =>
    db
      .prepare('INSERT INTO versions VALUES(?,?,?,?)')
      .run(value.interactionId, value.version, jcs(value), digest(value))
  const materialize = (id: string, version?: number): InteractionRecord | undefined => {
    const row = (
      version === undefined
        ? db.prepare('SELECT body,hash FROM versions WHERE id=? ORDER BY version DESC LIMIT 1').get(id)
        : db.prepare('SELECT body,hash FROM versions WHERE id=? AND version=?').get(id, version)
    ) as { body: string; hash: string } | undefined
    if (!row) return undefined
    const value: unknown = JSON.parse(row.body)
    if (digest(value) !== row.hash) refuse('incompatible', 'integrity', 'immutable source corrupted')
    const checked = validateRuntime('InteractionRecord', value)
    if (!checked.ok) throw Error('source fixture schema invalid')
    return checked.value
  }
  const ports: InteractionReadPorts = {
    async snapshot(body) {
      db.exec('BEGIN')
      try {
        const result = await body()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    async read(id) {
      const found = materialize(id)
      atReturn?.()
      return found
    },
    async response(id) {
      const row = db.prepare('SELECT body FROM responses WHERE id=?').get(id) as { body: string } | undefined
      return row
        ? { status: JSON.parse(row.body), runtimeAdmission: acknowledged ? 'acknowledged' : 'pending' }
        : undefined
    },
    async responseRealmComplete() {
      return complete
    },
    async cut(queryScope) {
      if (queryScope.kind !== 'session')
        refuse('conflict', 'interaction_unavailable', 'workspace membership source unavailable')
      const membership = db
        .prepare('SELECT id,MAX(version) AS version FROM versions GROUP BY id ORDER BY id')
        .all() as unknown as JsonValue
      return { scope: queryScope, snapshot: `cut-${digest(membership)}`, membership }
    },
    async recordsAt(cut) {
      const membership = cut.membership as { id: string; version: number }[]
      const values = membership.map(({ id, version }) => {
        const value = materialize(id, version)
        if (!value) refuse('incompatible', 'integrity', 'required version is missing')
        return value
      })
      atReturn?.()
      return values
    },
  }
  return {
    db,
    owner,
    ports,
    put,
    api: createInteractionReads(owner, ports),
    revoke: () => {
      revoked = true
    },
    partial: () => {
      complete = false
    },
    ack: () => {
      acknowledged = true
    },
    age: () => {
      now += 300_001
    },
    reader: () => {
      readerBinding = 'other-reader'
    },
    atReturn: (callback: () => void) => {
      atReturn = callback
    },
  }
}

describe('State private interaction read orchestration', () => {
  it('reads a verified current record without writing and rejects revoked readers', async () => {
    const f = fixture()
    f.put(question('q1'))
    const changes = f.db.prepare('SELECT total_changes() AS n').get()
    expect(await f.api.read('q1', context())).toEqual(question('q1'))
    expect(f.db.prepare('SELECT total_changes() AS n').get()).toEqual(changes)
    f.revoke()
    await expect(f.api.read('q1', context())).rejects.toMatchObject({ failure: { code: 'denied' } })
  })
  it('distinguishes authorized authoritative absence from an incomplete response realm', async () => {
    const f = fixture()
    expect(await f.api.responseStatus('unknown', context())).toEqual({
      responseId: 'unknown',
      status: 'not-accepted',
      interactionId: null,
      version: null,
      result: null,
      error: null,
    })
    f.partial()
    await expect(f.api.responseStatus('unknown', context())).rejects.toMatchObject({
      failure: { detailCode: 'interaction_unavailable' },
    })
    f.revoke()
    await expect(f.api.responseStatus('unknown', context())).rejects.toMatchObject({
      failure: { code: 'denied' },
    })
  })
  it('reports only the source-proven Runtime admission boundary', async () => {
    const f = fixture()
    // A rejected response fixture is separate from question lifecycle state.
    const rejected = {
      responseId: 'response',
      interactionId: 'q1',
      version: 1,
      status: 'rejected',
      result: null,
      error: null,
    }
    const checked = validateRuntime('InteractionResponseStatus', rejected)
    if (!checked.ok) throw Error('invalid rejected fixture')
    f.db.prepare('INSERT INTO responses VALUES(?,?,?)').run('response', jcs(checked.value), 'pending')
    expect((await f.api.responseStatus('response', context())).status).toBe('rejected')
    f.db
      .prepare('UPDATE responses SET body=? WHERE id=?')
      .run(jcs({ ...checked.value, status: 'accepted' }), 'response')
    expect((await f.api.responseStatus('response', context())).status).toBe('accepted')
    f.ack()
    expect((await f.api.responseStatus('response', context())).status).toBe('applied')
  })
  it('retains a stable historical cut across cold query helpers and later terminal versions', async () => {
    const f = fixture()
    f.put(question('q1'))
    f.put(question('q2'))
    f.put(question('q3'))
    const first = await f.api.pending({ scope, limit: 1 }, context())
    expect(first.items.map((x) => x.interactionId)).toEqual(['q1'])
    expect(first.complete).toBe(false)
    if (!first.nextCursor) throw Error('missing cursor')
    f.put({
      ...question('q2'),
      version: 2,
      status: 'cancelled',
      terminationReason: 'cancelled',
      resolution: null,
    })
    const cold = createInteractionReads(f.owner, f.ports)
    const second = await cold.pending({ scope, limit: 1, cursor: first.nextCursor }, context())
    expect(second.snapshot).toBe(first.snapshot)
    expect(second.items.map((x) => x.interactionId)).toEqual(['q2'])
    expect(second.items[0]?.status).toBe('pending')
    if (!second.nextCursor) throw Error('missing cursor')
    const third = await cold.pending({ scope, limit: 1, cursor: second.nextCursor }, context())
    expect(third.items.map((x) => x.interactionId)).toEqual(['q3'])
    expect(third.complete).toBe(true)
    expect(third.nextCursor).toBeNull()
  })
  it('refuses changed queries, reader, tampered and expired cursors', async () => {
    const f = fixture()
    f.put(question('q1'))
    f.put(question('q2'))
    const first = await f.api.pending({ scope, limit: 1 }, context())
    if (!first.nextCursor) throw Error('missing cursor')
    await expect(
      f.api.pending({ scope, limit: 2, cursor: first.nextCursor }, context()),
    ).rejects.toMatchObject({ failure: { detailCode: 'resync_required' } })
    await expect(
      f.api.pending({ scope, limit: 1, cursor: `${first.nextCursor}x` }, context()),
    ).rejects.toMatchObject({ failure: { detailCode: 'resync_required' } })
    f.reader()
    await expect(
      f.api.pending({ scope, limit: 1, cursor: first.nextCursor }, context()),
    ).rejects.toMatchObject({ failure: { detailCode: 'resync_required' } })
    f.age()
    await expect(
      f.api.pending({ scope, limit: 1, cursor: first.nextCursor }, context()),
    ).rejects.toMatchObject({ failure: { detailCode: 'resync_required' } })
  })
  it('fails the entire page for corrupt or lost retained versions and permission changes', async () => {
    const f = fixture()
    f.put(question('q1'))
    f.put(question('q2'))
    const first = await f.api.pending({ scope, limit: 1 }, context())
    if (!first.nextCursor) throw Error('missing cursor')
    f.db.prepare('DELETE FROM versions WHERE id=?').run('q2')
    await expect(
      f.api.pending({ scope, limit: 1, cursor: first.nextCursor }, context()),
    ).rejects.toMatchObject({ failure: { detailCode: 'integrity' } })
    f.atReturn(f.revoke)
    await expect(f.api.read('q1', context())).rejects.toMatchObject({ failure: { code: 'denied' } })
  })
  it('rejects corrupt immutable bodies and aborts before exposing data', async () => {
    const f = fixture()
    f.put(question('q1'))
    f.db.prepare('UPDATE versions SET body=? WHERE id=?').run(jcs(question('other')), 'q1')
    await expect(f.api.read('q1', context())).rejects.toMatchObject({ failure: { detailCode: 'integrity' } })
    const controller = new AbortController()
    controller.abort()
    await expect(
      f.api.responseStatus('unknown', { ...context(), signal: controller.signal }),
    ).rejects.toMatchObject({ failure: { code: 'denied' } })
  })
  it('does not write for pagination and refuses a page whose reader is revoked at return', async () => {
    const f = fixture()
    f.put(question('q1'))
    const before = f.db.prepare('SELECT total_changes() AS n').get()
    expect((await f.api.pending({ scope }, context())).complete).toBe(true)
    expect(f.db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
    f.atReturn(f.revoke)
    await expect(f.api.pending({ scope }, context())).rejects.toMatchObject({ failure: { code: 'denied' } })
    expect(f.db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
  })
  it('refuses a page when its protected cursor key changes during verification', async () => {
    const f = fixture()
    f.put(question('q1'))
    f.put(question('q2'))
    f.atReturn(() => f.owner.cursorKey.fill(12))
    await expect(f.api.pending({ scope, limit: 1 }, context())).rejects.toMatchObject({
      failure: { detailCode: 'resync_required' },
    })
  })
})
