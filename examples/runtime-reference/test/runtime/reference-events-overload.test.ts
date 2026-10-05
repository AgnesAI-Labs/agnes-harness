import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallContext } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import { createEventsFixture } from '../../../../packages/extension-api/testkit/runtime/contracts/events.js'
import { EVENTS_PROVIDER, openEventsStore } from '../../src/providers/events.js'

const workspace: Wire.ScopeRef = {
  kind: 'workspace',
  installationId: 'conformance',
  runtimeId: 'conformance',
  workspaceId: 'conformance',
}
const request: Wire.EventsSubscribeRequest = {
  scopeRef: { ...workspace, kind: 'session', sessionId: 'normal' },
  types: ['conformance.events/noted@1'],
  cursor: null,
  limit: 2,
}
const schema: Wire.SchemaRef = {
  typeId: 'conformance.events/noted@1',
  revision: 1,
  digest: canonicalJsonDigest('conformance.events/noted@1'),
}
const publication = (): Wire.EventsPublishRequest => {
  const value = { note: 'after-checkpoint' }
  return {
    domainSchema: schema,
    payload: {
      kind: 'inline',
      schema,
      value,
      digest: canonicalJsonDigest(value),
      bytes: Buffer.byteLength(jcs(value)),
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
    idempotencyKey: 'after-checkpoint',
    aggregate: {
      authorityId: 'conformance-domain',
      typeId: 'conformance.events/item@1',
      id: 'normal-item',
      revision: 1,
    },
  }
}
const reader = (signal = new AbortController().signal): CallContext => ({
  principalRef: 'events-reader',
  scope: workspace,
  bindingId: 'events-reader-binding',
  invocationId: 'overload-reader',
  deadline: '2100-01-01T00:00:00.000Z',
  traceRef: 'overload-reader',
  authorizationRef: 'overload-reader',
  signal,
})
const producer = (): CallContext => ({
  ...reader(),
  principalRef: 'events-producer',
  scope: request.scopeRef,
  bindingId: 'conformance-producer',
})

it('rejects a ninth pending read without consuming its checkpoint, then reads after release', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reference-events-overload-'))
  const fixture = createEventsFixture()
  let holdReads = false
  let failNextRead = false
  let entered = 0
  let notify = () => {}
  const eightEntered = new Promise<void>((resolve) => {
    notify = resolve
  })
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const store = openEventsStore(join(directory, 'events.sqlite'), {
    authorityId: 'reference-events-authority',
    binding: {
      bindingId: 'reference-events',
      contract: EVENTS_PROVIDER.contract,
      logicalName: 'events',
      providerId: EVENTS_PROVIDER.id,
    },
    access: {
      ...fixture.gate,
      async canRead(scope, context) {
        if (failNextRead) {
          failNextRead = false
          throw new Error('injected read admission failure')
        }
        if (!holdReads) return fixture.gate.canRead(scope, context)
        entered++
        if (entered === 8) notify()
        if (entered <= 8) await held
        return fixture.gate.canRead(scope, context)
      },
    },
  })
  try {
    const initial = await store.subscribe(request, reader())
    if (!initial.ok || initial.value.checkpoint === null) throw new Error('initial checkpoint is required')
    expect(initial.value.page.items).toEqual([])
    failNextRead = true
    expect(await store.subscribe({ ...request, cursor: initial.value.checkpoint }, reader())).toMatchObject({
      ok: false,
      error: { detailCode: 'internal_error' },
    })
    expect(await store.publish(publication(), producer())).toMatchObject({ ok: true })
    const resumedRequest = { ...request, cursor: initial.value.checkpoint }
    const intruder = { ...reader(), principalRef: 'events-intruder' }
    expect(await store.subscribe(resumedRequest, intruder)).toMatchObject({
      ok: false,
      error: { detailCode: 'permission_denied' },
    })
    holdReads = true
    const cancelled = new AbortController()
    const pending = [
      store.subscribe(resumedRequest, reader(cancelled.signal)),
      ...Array.from({ length: 7 }, () => store.subscribe(resumedRequest, reader())),
    ]
    await eightEntered
    const rejected = await store.subscribe(resumedRequest, reader())
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'quota', detailCode: 'rate_limit', retryAdvice: { kind: 'retry_read' } },
    })
    if (rejected.ok) throw new Error('overload should be refused')
    const retryAt = Date.parse(rejected.error.retryAdvice.notBefore ?? '')
    expect(retryAt).toBeGreaterThan(Date.now() - 1000)
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 1000)
    expect(entered).toBe(8)
    expect(await store.subscribe(resumedRequest, intruder)).toMatchObject({
      ok: false,
      error: { detailCode: 'rate_limit' },
    })
    cancelled.abort()
    expect(await pending[0]).toMatchObject({ ok: false, error: { detailCode: 'cancelled' } })
    const freed = await store.subscribe(resumedRequest, reader())
    expect(freed.ok).toBe(true)
    expect(entered).toBe(9)
    release()
    const first = await Promise.all(pending)
    expect(first.slice(1).every((reply) => reply.ok && reply.value.page.items.length === 1)).toBe(true)
    const after = await store.subscribe(resumedRequest, reader())
    expect(after.ok).toBe(true)
    if (after.ok) {
      expect(after.value.page.items).toHaveLength(1)
      expect(after.value.page.items).toEqual(first[1]?.ok ? first[1].value.page.items : [])
      expect(after.value.checkpoint).toEqual(first[1]?.ok ? first[1].value.checkpoint : null)
    }
  } finally {
    release()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('settles a read waiting on the authority when the store closes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reference-events-close-read-'))
  const fixture = createEventsFixture()
  let entered = () => {}
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const store = openEventsStore(join(directory, 'events.sqlite'), {
    authorityId: 'reference-events-authority',
    binding: {
      bindingId: 'reference-events',
      contract: EVENTS_PROVIDER.contract,
      logicalName: 'events',
      providerId: EVENTS_PROVIDER.id,
    },
    access: {
      ...fixture.gate,
      async canRead() {
        entered()
        return new Promise<boolean>(() => {})
      },
    },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const pending = store.subscribe(request, reader())
    await started
    store.close()
    const settled = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('closed store left a read pending')), 250)
      }),
    ])
    expect(settled).toMatchObject({ ok: false, error: { detailCode: 'backend_unavailable' } })
  } finally {
    if (timer) clearTimeout(timer)
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
