import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext } from '@agnes/extension-api/runtime'
import type { CaseContext } from '@agnes/extension-api/testkit'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import { createEventsFixture } from '../../../../packages/extension-api/testkit/runtime/contracts/events.js'
import { inline } from '../../../../packages/extension-api/testkit/runtime/contracts/projection.js'
import { openEventsStore } from '../../src/providers/events.js'
import { referenceEventsPort } from '../../src/providers/events-contract.js'

it('rejects an interior sequence gap even when count and max still equal highwater', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reference-events-disguised-gap-'))
  const path = join(directory, 'events.sqlite')
  const reference = referenceEventsPort(path)
  try {
    const seen = await reference.port.normal({} as CaseContext)
    const last = seen.resumed
    if (last === undefined || 'refused' in last || last.checkpoint === null)
      throw new Error('normal scenario did not issue a checkpoint')
    const selected = await reference.port.select({} as CaseContext)
    reference.close()
    const db = new DatabaseSync(path)
    db.prepare('UPDATE events SET sequence = 0 WHERE sequence = 1').run()
    expect(db.prepare('SELECT COUNT(*) AS count, MAX(sequence) AS head FROM events').get()).toEqual({
      count: 7,
      head: 7,
    })
    db.close()
    const store = openEventsStore(path, {
      binding: selected.binding.binding,
      authorityId: 'reference-events-authority',
      access: createEventsFixture().gate,
    })
    try {
      const context: CallContext = {
        principalRef: 'events-reader',
        scope: {
          kind: 'workspace',
          installationId: 'conformance',
          runtimeId: 'conformance',
          workspaceId: 'conformance',
        },
        bindingId: 'events-reader-binding',
        invocationId: 'disguised-gap-read',
        deadline: '2100-01-01T00:00:00.000Z',
        traceRef: 'disguised-gap-read',
        authorizationRef: 'disguised-gap-read',
        signal: new AbortController().signal,
      }
      const request = {
        scopeRef: { ...context.scope, kind: 'session', sessionId: 'normal' },
        types: ['conformance.events/noted@1', 'conformance.events/closed@1'],
        limit: 2,
      }
      for (const cursor of [null, last.checkpoint]) {
        const result = await store.subscribe({ ...request, cursor }, context)
        expect(result).toMatchObject({ ok: false, error: { detailCode: 'resync_required' } })
      }
    } finally {
      store.close()
    }
  } finally {
    reference.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('rejects an old checkpoint after persisted event history has a gap', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reference-events-gap-'))
  const path = join(directory, 'events.sqlite')
  const reference = referenceEventsPort(path)
  try {
    const seen = await reference.port.normal({} as CaseContext)
    const last = seen.resumed
    if (last === undefined || 'refused' in last || last.checkpoint === null)
      throw new Error('normal scenario did not issue a checkpoint')
    const checkpoint = last.checkpoint
    const selected = await reference.port.select({} as CaseContext)
    reference.close()
    const db = new DatabaseSync(path)
    db.prepare('DELETE FROM events WHERE sequence = 1').run()
    db.close()

    const store = openEventsStore(path, {
      binding: selected.binding.binding,
      authorityId: 'reference-events-authority',
      access: createEventsFixture().gate,
    })
    try {
      const context: CallContext = {
        principalRef: 'events-reader',
        scope: {
          kind: 'workspace',
          installationId: 'conformance',
          runtimeId: 'conformance',
          workspaceId: 'conformance',
        },
        bindingId: 'events-reader-binding',
        invocationId: 'gap-read',
        deadline: '2100-01-01T00:00:00.000Z',
        traceRef: 'gap-read',
        authorizationRef: 'gap-authorization',
        signal: new AbortController().signal,
      }
      const result = await store.subscribe(
        {
          scopeRef: { ...context.scope, kind: 'session', sessionId: 'normal' },
          types: ['conformance.events/noted@1', 'conformance.events/closed@1'],
          cursor: checkpoint,
          limit: 2,
        },
        context,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.detailCode).toBe('resync_required')
    } finally {
      store.close()
    }
  } finally {
    reference.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('rejects another authority over the same durable event log without changing its identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reference-events-authority-'))
  const path = join(directory, 'events.sqlite')
  const reference = referenceEventsPort(path)
  try {
    await reference.port.normal({} as CaseContext)
    const selected = await reference.port.select({} as CaseContext)
    reference.close()
    const db = new DatabaseSync(path)
    const before = db.prepare('SELECT * FROM events_cursor_authority').all()
    const eventCount = db.prepare('SELECT COUNT(*) AS count FROM events').get()
    db.close()
    expect(() =>
      openEventsStore(path, {
        binding: selected.binding.binding,
        authorityId: 'foreign-events-authority',
        access: createEventsFixture().gate,
      }),
    ).toThrow('event store belongs to another authority')
    const after = new DatabaseSync(path)
    expect(after.prepare('SELECT * FROM events_cursor_authority').all()).toEqual(before)
    expect(after.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual(eventCount)
    after.close()
  } finally {
    reference.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('does not reuse a deleted tail sequence or accept its old checkpoint', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reference-events-tail-'))
  const path = join(directory, 'events.sqlite')
  const reference = referenceEventsPort(path)
  try {
    const seen = await reference.port.normal({} as CaseContext)
    const last = seen.resumed
    if (last === undefined || 'refused' in last || last.checkpoint === null)
      throw new Error('normal scenario did not issue a checkpoint')
    const checkpoint = last.checkpoint
    const selected = await reference.port.select({} as CaseContext)
    reference.close()
    const db = new DatabaseSync(path)
    db.prepare('DELETE FROM events WHERE sequence = (SELECT MAX(sequence) FROM events)').run()
    const before = db.prepare('SELECT COUNT(*) AS count FROM events').get()
    db.close()
    const fixture = createEventsFixture()
    fixture.recordAggregate('new-item', {
      kind: 'session',
      installationId: 'conformance',
      runtimeId: 'conformance',
      workspaceId: 'conformance',
      sessionId: 'normal',
    })
    const store = openEventsStore(path, {
      binding: selected.binding.binding,
      authorityId: 'reference-events-authority',
      access: fixture.gate,
    })
    try {
      const scope = {
        kind: 'session' as const,
        installationId: 'conformance',
        runtimeId: 'conformance',
        workspaceId: 'conformance',
        sessionId: 'normal',
      }
      const context: CallContext = {
        principalRef: 'events-producer',
        scope,
        bindingId: 'conformance-producer',
        invocationId: 'tail-publish',
        deadline: '2100-01-01T00:00:00.000Z',
        traceRef: 'tail-publish',
        authorizationRef: 'tail-authorization',
        signal: new AbortController().signal,
      }
      const schema = {
        typeId: 'conformance.events/noted@1',
        revision: 1,
        digest: canonicalJsonDigest('conformance.events/noted@1'),
      }
      const published = await store.publish(
        {
          domainSchema: schema,
          payload: inline(schema, { note: 'after-tail-deletion' }),
          causationRef: {
            kind: 'run',
            value: {
              runId: 'normal-run',
              session: {
                sessionId: 'normal',
                authority: { authorityId: 'conformance-state', tenantId: 'conformance', authorityEpoch: 1 },
              },
            },
          },
          typeId: schema.typeId,
          idempotencyKey: 'after-tail-deletion',
          aggregate: {
            authorityId: 'conformance-domain',
            typeId: 'conformance.events/item@1',
            id: 'new-item',
            revision: 1,
          },
        },
        context,
      )
      expect(published.ok).toBe(false)
      if (!published.ok) expect(published.error.detailCode).toBe('resync_required')
      const read = await store.subscribe(
        { scopeRef: scope, types: [schema.typeId], cursor: checkpoint, limit: 2 },
        { ...context, principalRef: 'events-reader', bindingId: 'events-reader-binding' },
      )
      expect(read.ok).toBe(false)
      if (!read.ok) expect(read.error.detailCode).toBe('resync_required')
    } finally {
      store.close()
    }
    const after = new DatabaseSync(path)
    expect(after.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual(before)
    after.close()
  } finally {
    reference.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
