import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import { createEventsFixture } from '../../../../packages/extension-api/testkit/runtime/contracts/events.js'
import { EVENTS_PROVIDER, openEventsStore } from '../../src/providers/events.js'

const scope = (sessionId: string): Wire.ScopeRef => ({
  kind: 'session',
  installationId: 'conformance',
  runtimeId: 'conformance',
  workspaceId: 'conformance',
  sessionId,
})
const schema: Wire.SchemaRef = {
  typeId: 'conformance.events/noted@1',
  revision: 1,
  digest: canonicalJsonDigest('conformance.events/noted@1'),
}
const context: CallContext = {
  principalRef: 'events-producer',
  scope: scope('normal'),
  bindingId: 'conformance-producer',
  invocationId: 'race-invocation',
  deadline: '2100-01-01T00:00:00.000Z',
  traceRef: 'race-trace',
  authorizationRef: 'race-authorization',
  signal: new AbortController().signal,
}
const request = (key: string): Wire.EventsPublishRequest => {
  const value = { note: key }
  return {
    domainSchema: schema,
    payload: {
      kind: 'inline',
      schema,
      value,
      digest: canonicalJsonDigest(value),
      bytes: new TextEncoder().encode(jcs(value)).length,
    },
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
    idempotencyKey: key,
    aggregate: {
      authorityId: 'conformance-domain',
      typeId: 'conformance.events/item@1',
      id: 'normal-item',
      revision: 1,
    },
  }
}
const pause = () => {
  let started = () => {}
  let release = () => {}
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  return { entered, waiting, started, release }
}

function withStore(
  run: (
    fixture: ReturnType<typeof createEventsFixture>,
    gate: ReturnType<typeof createEventsFixture>['gate'],
    path: string,
  ) => Promise<void>,
) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), 'reference-events-race-'))
    const path = join(directory, 'events.sqlite')
    const fixture = createEventsFixture()
    try {
      await run(fixture, fixture.gate, path)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

const rows = (path: string) => {
  const db = new DatabaseSync(path)
  try {
    return (db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count
  } finally {
    db.close()
  }
}

it(
  'refuses a new event when aggregate revision changes after the async revision read',
  withStore(async (fixture, gate, path) => {
    const store = openEventsStore(path, {
      authorityId: 'reference-events-authority',
      binding: {
        bindingId: 'reference-events',
        contract: EVENTS_PROVIDER.contract,
        logicalName: 'events',
        providerId: EVENTS_PROVIDER.id,
      },
      access: {
        ...gate,
        async revision(aggregate) {
          const observed = await gate.revision(aggregate)
          fixture.revise(aggregate.id)
          return observed
        },
      },
    })
    try {
      expect(await store.publish(request('revision-race'), context)).toMatchObject({
        ok: false,
        error: { detailCode: 'revision_conflict' },
      })
      expect(rows(path)).toBe(0)
    } finally {
      store.close()
    }
  }),
)

it(
  'denies a new event when the producer is revoked while revision waits, without writing',
  withStore(async (fixture, gate, path) => {
    const held = pause()
    const store = openEventsStore(path, {
      authorityId: 'reference-events-authority',
      binding: {
        bindingId: 'reference-events',
        contract: EVENTS_PROVIDER.contract,
        logicalName: 'events',
        providerId: EVENTS_PROVIDER.id,
      },
      access: {
        ...gate,
        async revision(aggregate) {
          const revision = await gate.revision(aggregate)
          held.started()
          await held.waiting
          return revision
        },
      },
    })
    try {
      const pending = store.publish(request('race-new'), context)
      await held.entered
      fixture.revokeProducer()
      held.release()
      expect(await pending).toMatchObject({ ok: false, error: { detailCode: 'permission_denied' } })
      expect(rows(path)).toBe(0)
    } finally {
      store.close()
    }
  }),
)

it(
  'denies a new event when aggregate origin changes while revision waits, without writing',
  withStore(async (fixture, gate, path) => {
    const held = pause()
    const store = openEventsStore(path, {
      authorityId: 'reference-events-authority',
      binding: {
        bindingId: 'reference-events',
        contract: EVENTS_PROVIDER.contract,
        logicalName: 'events',
        providerId: EVENTS_PROVIDER.id,
      },
      access: {
        ...gate,
        async revision(aggregate) {
          const revision = await gate.revision(aggregate)
          held.started()
          await held.waiting
          return revision
        },
      },
    })
    try {
      const pending = store.publish(request('race-origin'), context)
      await held.entered
      fixture.recordAggregate('normal-item', scope('elsewhere'))
      held.release()
      expect(await pending).toMatchObject({ ok: false, error: { detailCode: 'permission_denied' } })
      expect(rows(path)).toBe(0)
    } finally {
      store.close()
    }
  }),
)

it(
  'denies a same-key replay when producer is revoked while origin waits, without a new row',
  withStore(async (fixture, gate, path) => {
    const held = pause()
    let holdOrigin = false
    const store = openEventsStore(path, {
      authorityId: 'reference-events-authority',
      binding: {
        bindingId: 'reference-events',
        contract: EVENTS_PROVIDER.contract,
        logicalName: 'events',
        providerId: EVENTS_PROVIDER.id,
      },
      access: {
        ...gate,
        async origin(...args) {
          const origin = await gate.origin(...args)
          if (holdOrigin) {
            held.started()
            await held.waiting
          }
          return origin
        },
      },
    })
    try {
      expect((await store.publish(request('race-replay'), context)).ok).toBe(true)
      holdOrigin = true
      const pending = store.publish(request('race-replay'), context)
      await held.entered
      fixture.revokeProducer()
      held.release()
      expect(await pending).toMatchObject({ ok: false, error: { detailCode: 'permission_denied' } })
      expect(rows(path)).toBe(1)
    } finally {
      store.close()
    }
  }),
)

it(
  'denies a raced same-key replay after revision wait when its producer has been revoked',
  withStore(async (fixture, gate, path) => {
    const held = pause()
    let holdFirstRevision = true
    const store = openEventsStore(path, {
      authorityId: 'reference-events-authority',
      binding: {
        bindingId: 'reference-events',
        contract: EVENTS_PROVIDER.contract,
        logicalName: 'events',
        providerId: EVENTS_PROVIDER.id,
      },
      access: {
        ...gate,
        async revision(aggregate) {
          const revision = await gate.revision(aggregate)
          if (holdFirstRevision) {
            holdFirstRevision = false
            held.started()
            await held.waiting
          }
          return revision
        },
      },
    })
    try {
      const pending = store.publish(request('race-same-key'), context)
      await held.entered
      expect((await store.publish(request('race-same-key'), context)).ok).toBe(true)
      fixture.revokeProducer()
      held.release()
      expect(await pending).toMatchObject({ ok: false, error: { detailCode: 'permission_denied' } })
      expect(rows(path)).toBe(1)
    } finally {
      store.close()
    }
  }),
)

it(
  'holds producer and aggregate origin through the physical event write',
  withStore(async (fixture, gate, path) => {
    const store = openEventsStore(path, {
      authorityId: 'reference-events-authority',
      binding: {
        bindingId: 'reference-events',
        contract: EVENTS_PROVIDER.contract,
        logicalName: 'events',
        providerId: EVENTS_PROVIDER.id,
      },
      access: {
        ...gate,
        withCommit(typeId, schema, aggregate, causation, context, body) {
          return gate.withCommit(typeId, schema, aggregate, causation, context, (facts) => {
            fixture.revokeProducer()
            fixture.recordAggregate('normal-item', scope('elsewhere'))
            return body(facts)
          })
        },
      },
    })
    try {
      expect(await store.publish(request('gate-after-check'), context)).toMatchObject({
        ok: false,
        error: { detailCode: 'internal_error' },
      })
      expect(rows(path)).toBe(0)
      expect((await gate.producer(schema.typeId, schema, context)).ok).toBe(true)
    } finally {
      store.close()
    }
  }),
)

it(
  'refuses an aggregate origin change attempted after the commit gate checks',
  withStore(async (fixture, gate, path) => {
    const store = openEventsStore(path, {
      authorityId: 'reference-events-authority',
      binding: {
        bindingId: 'reference-events',
        contract: EVENTS_PROVIDER.contract,
        logicalName: 'events',
        providerId: EVENTS_PROVIDER.id,
      },
      access: {
        ...gate,
        withCommit(typeId, schema, aggregate, causation, context, body) {
          return gate.withCommit(typeId, schema, aggregate, causation, context, (facts) => {
            fixture.recordAggregate('normal-item', scope('elsewhere'))
            return body(facts)
          })
        },
      },
    })
    try {
      expect(await store.publish(request('gate-origin'), context)).toMatchObject({
        ok: false,
        error: { detailCode: 'internal_error' },
      })
      expect(rows(path)).toBe(0)
      expect(
        (
          await gate.origin(
            request('gate-origin').aggregate,
            request('gate-origin').causationRef,
            {
              bindingId: 'conformance-producer',
              contract: 'conformance.events',
              logicalName: 'notes',
              providerId: 'conformance-producer',
            },
            context,
          )
        ).ok,
      ).toBe(true)
    } finally {
      store.close()
    }
  }),
)

it(
  'refuses to mount a store without a commit-bound authority capability',
  withStore(async (_fixture, gate, path) => {
    expect(() =>
      openEventsStore(path, {
        authorityId: 'reference-events-authority',
        binding: {
          bindingId: 'reference-events',
          contract: EVENTS_PROVIDER.contract,
          logicalName: 'events',
          providerId: EVENTS_PROVIDER.id,
        },
        access: { ...gate, withCommit: undefined } as unknown as typeof gate,
      }),
    ).toThrow('bound commit authority')
  }),
)

it(
  'refuses a gate that claims success without running the bounded publication',
  withStore(async (_fixture, gate, path) => {
    const store = openEventsStore(path, {
      authorityId: 'reference-events-authority',
      binding: {
        bindingId: 'reference-events',
        contract: EVENTS_PROVIDER.contract,
        logicalName: 'events',
        providerId: EVENTS_PROVIDER.id,
      },
      access: {
        ...gate,
        withCommit<T>(): Outcome<T> {
          return { ok: true, value: undefined as T }
        },
      },
    })
    try {
      expect(await store.publish(request('no-callback'), context)).toMatchObject({
        ok: false,
        error: { detailCode: 'permission_denied' },
      })
      expect(rows(path)).toBe(0)
    } finally {
      store.close()
    }
  }),
)

it(
  'refuses a second commit callback before it can begin another transaction',
  withStore(async (_fixture, gate, path) => {
    let gateCalls = 0
    const store = openEventsStore(path, {
      authorityId: 'reference-events-authority',
      binding: {
        bindingId: 'reference-events',
        contract: EVENTS_PROVIDER.contract,
        logicalName: 'events',
        providerId: EVENTS_PROVIDER.id,
      },
      access: {
        ...gate,
        withCommit(typeId, schema, aggregate, causation, context, body) {
          gateCalls++
          if (gateCalls === 1) return gate.withCommit(typeId, schema, aggregate, causation, context, body)
          return gate.withCommit(typeId, schema, aggregate, causation, context, (facts) => {
            body(facts)
            return body(facts)
          })
        },
      },
    })
    try {
      expect(await store.publish(request('double-callback'), context)).toMatchObject({
        ok: false,
        error: { detailCode: 'permission_denied' },
      })
      expect(rows(path)).toBe(1)
      const db = new DatabaseSync(path)
      try {
        expect(db.prepare('SELECT highwater FROM events_cursor_authority WHERE slot = 1').get()).toEqual({
          highwater: 1,
        })
      } finally {
        db.close()
      }
    } finally {
      store.close()
    }
  }),
)
