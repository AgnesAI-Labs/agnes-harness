import { rmSync } from 'node:fs'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  type StateOpenRequest,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { createRuntimeStateStore } from '../../src/runtime/providers/state.js'
import { createStateQueryService } from '../../src/runtime/state/query-service.js'
import { originalNativeFixture } from './fixtures/native-state-read-fixture.js'
import { callerWith, sessionScope } from './fixtures/state-query-fixture.js'

const methods = RuntimeMethodSchemaRefs['agh.state'].scan
const binding = {
  bindingId: 'state',
  contract: 'agh.state',
  logicalName: 'state',
  providerId: 'state-provider',
}

async function within(
  body: (ctx: {
    native: Awaited<ReturnType<typeof originalNativeFixture>>
    service: ReturnType<typeof createStateQueryService>
    storeWith: ReturnType<typeof stores>['storeWith']
    plain: ReturnType<typeof stores>['plain']
    readRequest: StateOpenRequest
  }) => Promise<void>,
) {
  const native = await originalNativeFixture()
  const service = createStateQueryService({
    owner: native.reader,
    bridge: native.bridge,
    authority: native.authority,
    now: native.now,
  })
  try {
    await native.fixture.coordinator.coordinate(native.fixture.draft(), native.fixture.context())
    const { storeWith, plain } = stores(native)
    await body({
      native,
      service,
      storeWith,
      plain,
      readRequest: {
        requestId: 'read',
        authority: native.authority,
        sessionId: 'fixture-session',
        mode: 'read',
        writerId: null,
        ttlMs: null,
      } as StateOpenRequest,
    })
  } finally {
    await service.close()
    await native.reader.close()
    native.identity.close()
    await native.fixture.close()
    rmSync(native.directory, { recursive: true, force: true })
  }
}
/** Stores over the fixture's own State connection; the fixture closes that connection. */
function stores(native: Awaited<ReturnType<typeof originalNativeFixture>>) {
  const { options } = native.fixture
  return {
    plain: () => createRuntimeStateStore(options, native.fixture.state),
    storeWith: (service: ReturnType<typeof createStateQueryService>) =>
      createRuntimeStateStore(options, native.fixture.state, service),
  }
}
function scanOf(snapshot: { snapshotId: string }) {
  const request = { snapshot, collection: 'records', filter: {}, order: 'asc', cursor: null, limit: 500 }
  const body = boundedCanonicalJson(request, { maxBytes: 262_144, maxDepth: 64, maxMembers: 16_384 })
  if (!body.ok) throw Error('bounds')
  return {
    target: binding,
    method: 'scan',
    snapshot: snapshot.snapshotId,
    input: {
      kind: 'inline',
      schema: methods.input,
      value: body.value.json,
      digest: canonicalJsonDigest(body.value.json),
      bytes: body.value.bytes,
    },
  } as never
}

describe.skipIf(typeof process.getuid !== 'function')('State provider read wiring', () => {
  it('has no read service and mints read snapshots exactly as before when none is supplied', async () => {
    await within(async ({ native, plain, readRequest }) => {
      const store = plain()
      expect(store.query).toBeNull()
      expect(store.reader).toBeNull()
      const opened = await store.open(readRequest, native.context)
      expect(opened.ok && opened.value.claim).toBeNull()
      expect(opened.ok && opened.value.snapshot.sessionId).toBe('fixture-session')
    })
  }, 120_000)

  it('delegates read opens to the service, so its scan accepts the snapshot, and leaves write opens alone', async () => {
    await within(async ({ native, service, storeWith, readRequest }) => {
      const store = storeWith(service)
      expect(store.query).toBe(service.query)
      expect(store.reader).toBe(service.reader)
      const caller = callerWith(native, sessionScope(native))
      const read = await store.open(readRequest, native.context)
      if (!read.ok) throw Error(JSON.stringify(read.error))
      expect(read.value.claim).toBeNull()
      const wire = await service.query(scanOf(read.value.snapshot), caller)
      expect(wire.ok, JSON.stringify(wire)).toBe(true)
      const write = await store.open(
        {
          ...readRequest,
          requestId: 'write',
          mode: 'write',
          writerId: 'writer',
          ttlMs: 600_000,
        } as StateOpenRequest,
        native.context,
      )
      if (!write.ok) throw Error(JSON.stringify(write.error))
      expect(write.value.claim).not.toBeNull()
    })
  }, 120_000)

  it('does not let the service accept a snapshot minted by the plain open path', async () => {
    await within(async ({ native, service, plain, readRequest }) => {
      const minted = await plain().open(readRequest, native.context)
      if (!minted.ok) throw Error(JSON.stringify(minted.error))
      const caller = callerWith(native, sessionScope(native))
      const wire = await service.query(scanOf(minted.value.snapshot), caller)
      expect(wire).toMatchObject({ ok: false, error: { detailCode: 'resync_required' } })
    })
  }, 120_000)

  it('refuses a read open of a session the bridge does not grant, without falling back to the plain path', async () => {
    await within(async ({ native, service, storeWith, readRequest }) => {
      const refused = await storeWith(service).open(
        { ...readRequest, sessionId: 'someone-elses-session' } as StateOpenRequest,
        native.context,
      )
      expect(refused).toMatchObject({ ok: false, error: { detailCode: 'state_scope' } })
    })
  }, 120_000)
})
