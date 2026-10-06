import { rmSync } from 'node:fs'
import type { BoundService, CallContext, Outcome } from '@agnes/extension-api/runtime'
import { type JsonValue, RuntimeSchemaRefs, type StateScanRequest } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStateQueryService } from '../../src/runtime/state/query-service.js'
import { originalNativeFixture } from './fixtures/native-state-read-fixture.js'
import { callerWith, FIXTURE_SESSION, runScope } from './fixtures/state-query-fixture.js'

type Consume = (
  state: BoundService,
  request: StateScanRequest,
  call: CallContext,
  resolve: (ref: never, call: CallContext) => Promise<Outcome<JsonValue>>,
) => Promise<Outcome<readonly { reference: { schema: unknown }; value: JsonValue }[]>>

const binding = {
  bindingId: 'state',
  contract: 'agh.state',
  logicalName: 'state',
  providerId: 'state-provider',
}
const inlineValue = async (ref: { value: JsonValue }): Promise<Outcome<JsonValue>> => ({
  ok: true,
  value: ref.value,
})

async function within(
  body: (ctx: {
    native: Awaited<ReturnType<typeof originalNativeFixture>>
    consume: Consume
    state: BoundService
    open: (caller: CallContext) => Promise<StateScanRequest['snapshot']>
    request: (snapshot: StateScanRequest['snapshot'], typeIds?: string[]) => StateScanRequest
  }) => Promise<void>,
) {
  const native = await originalNativeFixture()
  // The consumer reads the wall clock for snapshot expiry; the fixture's State runs on its own fixed
  // instant, so only Date is pinned to it and timers stay real.
  vi.useFakeTimers({ toFake: ['Date'], now: native.now() })
  const service = createStateQueryService({
    owner: native.reader,
    bridge: native.bridge,
    authority: native.authority,
    now: native.now,
  })
  const loaded = (await import(
    new URL('../../../../tools/acceptance/runtime/platform/loop-recovery-scan.ts', import.meta.url).href
  )) as { scanLoopRecoveryRecords: Consume }
  try {
    await native.fixture.coordinator.coordinate(native.fixture.draft(), native.fixture.context())
    const state = {
      binding,
      query: (query: Parameters<typeof service.query>[0], call: CallContext) => service.query(query, call),
    } as unknown as BoundService
    await body({
      native,
      consume: loaded.scanLoopRecoveryRecords,
      state,
      async open(caller) {
        const opened = await service.open(
          {
            requestId: 'loop',
            authority: native.authority,
            sessionId: FIXTURE_SESSION,
            mode: 'read',
            writerId: null,
            ttlMs: null,
          },
          caller,
        )
        if (!opened.ok) throw Error(JSON.stringify(opened.error))
        return opened.value.snapshot
      },
      request: (snapshot, typeIds) => ({
        snapshot,
        collection: 'records',
        filter: typeIds ? { typeIds } : {},
        order: 'asc',
        cursor: null,
        limit: 100,
      }),
    })
  } finally {
    await service.close()
    await native.reader.close()
    native.identity.close()
    await native.fixture.close()
    rmSync(native.directory, { recursive: true, force: true })
  }
}
const asRun = (native: Awaited<ReturnType<typeof originalNativeFixture>>, runId?: string): CallContext => ({
  ...callerWith(native, runScope(native, runId)),
  bindingId: binding.bindingId,
})

describe.skipIf(typeof process.getuid !== 'function')('State scan through the Loop recovery consumer', () => {
  afterEach(() => vi.useRealTimers())

  it('reads the run record end to end under a run scope, as Stored envelopes', async () => {
    await within(async ({ native, consume, state, open, request }) => {
      const caller = asRun(native)
      const snapshot = await open(caller)
      const read = await consume(
        state,
        request(snapshot, [RuntimeSchemaRefs.RunRecordValue.typeId]),
        caller,
        inlineValue as never,
      )
      if (!read.ok) throw Error(JSON.stringify(read.error))
      expect(read.value).toHaveLength(1)
      expect(read.value[0]?.reference.schema).toEqual(RuntimeSchemaRefs.StoredRecord)
      expect(read.value[0]?.value).toMatchObject({
        meta: { schema: RuntimeSchemaRefs.RunRecordValue },
        value: { runId: 'fixture-run-old' },
      })
    })
  }, 120_000)

  it('reads nothing for another run and fails on an unknown or altered snapshot, with no partial result', async () => {
    await within(async ({ native, consume, state, open, request }) => {
      const other = asRun(native, 'some-other-run')
      const none = await consume(state, request(await open(other)), other, inlineValue as never)
      expect(none).toEqual({ ok: true, value: [] })
      const caller = asRun(native)
      const snapshot = await open(caller)
      const unknown = await consume(
        state,
        request({ ...snapshot, snapshotId: 'never-opened' }),
        caller,
        inlineValue as never,
      )
      expect(unknown).toMatchObject({ ok: false, error: { detailCode: 'resync_required' } })
      const forged = await consume(
        state,
        request({ ...snapshot, throughSeq: snapshot.throughSeq + 1 }),
        caller,
        inlineValue as never,
      )
      expect(forged).toMatchObject({ ok: false, error: { detailCode: 'state_snapshot' } })
    })
  }, 120_000)
})
