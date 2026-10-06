import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  type ScopeRef,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { createStateQueryService } from '../../src/runtime/state/query-service.js'
import type { StateReadBridge } from '../../src/runtime/state/read-scope.js'
import { originalNativeFixture } from './fixtures/native-state-read-fixture.js'
import {
  actionScope,
  callerWith,
  commitPreparedActions,
  FIXTURE_RUN,
  FIXTURE_SESSION,
  holdStateReads,
  type NativeFixture,
  runScope,
  sessionScope,
} from './fixtures/state-query-fixture.js'

type Native = NativeFixture
const methods = RuntimeMethodSchemaRefs['agh.state'].scan
const limits = { maxBytes: 262_144, maxDepth: 64, maxMembers: 16_384 }
const binding = {
  bindingId: 'state',
  contract: 'agh.state',
  logicalName: 'state',
  providerId: 'state-provider',
}
function inline(schema: unknown, value: unknown) {
  const body = boundedCanonicalJson(value, limits)
  if (!body.ok) throw Error('bounds')
  return {
    kind: 'inline' as const,
    schema,
    value: body.value.json,
    digest: canonicalJsonDigest(body.value.json),
    bytes: body.value.bytes,
  }
}
// biome-ignore lint/suspicious/noExplicitAny: wire values are built loose on purpose to test refusals
type Loose = any
function wire(
  snapshot: Loose,
  collection: string,
  filter: Record<string, unknown> = {},
  cursor: string | null = null,
  limit = 500,
): Loose {
  const request = { snapshot, collection, filter, order: 'asc', cursor, limit }
  return {
    target: binding,
    method: 'scan',
    snapshot: snapshot.snapshotId,
    input: inline(methods.input, request),
  }
}
function openRequest(native: Native, sessionId = FIXTURE_SESSION): Loose {
  return {
    requestId: 'r',
    authority: native.authority,
    sessionId,
    mode: 'read',
    writerId: null,
    ttlMs: null,
  }
}
function pageOf(reply: Loose) {
  expect(reply.ok, JSON.stringify(reply.error)).toBe(true)
  expect(reply.value.kind).toBe('value')
  expect(reply.value.output.schema).toEqual(methods.output)
  const decoded = validateRuntime('StateScanResult', reply.value.output.value)
  if (!decoded.ok) throw Error('page invalid')
  return decoded.value
}
const strip = (r: Loose) => ({
  ok: r.ok,
  code: r.error?.code,
  detail: r.error?.detailCode,
  message: r.error?.message,
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function withService(
  body: (ctx: { native: Native; service: Loose; bridge: StateReadBridge }) => Promise<void>,
  wrap: (bridge: StateReadBridge) => StateReadBridge = (bridge) => bridge,
) {
  const native = await originalNativeFixture()
  const bridge = wrap(native.bridge)
  const service = createStateQueryService({
    owner: native.reader,
    bridge,
    authority: native.authority,
    now: native.now,
  })
  try {
    await native.fixture.coordinator.coordinate(native.fixture.draft(), native.fixture.context())
    await body({ native, service, bridge })
  } finally {
    // service, then read owner, then State; the identity closes itself outside this chain
    await service.close()
    await native.reader.close()
    native.identity.close()
    await native.fixture.close()
    rmSync(native.directory, { recursive: true, force: true })
  }
}
async function openSnapshot(native: Native, service: Loose, caller = sessionCaller(native)) {
  const opened = await service.open(openRequest(native), caller)
  expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
  return opened.value.snapshot
}
const sessionCaller = (native: Native) => callerWith(native, sessionScope(native))
/** Only the grants asked for with no session (every later call) are toggled; the registered one is not. */
function currentGrantToggle() {
  const state = { broken: false, otherAuthority: false }
  const wrap = (bridge: StateReadBridge): StateReadBridge => ({
    ownedSessions: (caller, page) => bridge.ownedSessions(caller, page),
    grant(caller, requested) {
      const grant = bridge.grant(caller, requested)
      if (!grant || requested !== null) return grant
      return {
        ...grant,
        get fingerprint() {
          return state.otherAuthority ? 'another-authorization' : grant.fingerprint
        },
        check() {
          if (state.broken) throw new Error('revoked')
          grant.check()
        },
      }
    },
  })
  return { state, wrap }
}

describe.skipIf(typeof process.getuid !== 'function')('State scan query', () => {
  it('returns Stored envelopes whose meta is the proven history, with no trust flags', async () => {
    await withService(async ({ native, service }) => {
      const runtime = callerWith(native, native.scope)
      const opened = await service.open(openRequest(native), runtime)
      expect(opened.ok).toBe(true)
      const snapshot = opened.value.snapshot
      const reply = await service.query(wire(snapshot, 'records'), sessionCaller(native))
      const result = pageOf(reply)
      expect(result.snapshot).toBe(snapshot.snapshotId)
      expect(result.items).toHaveLength(2)
      for (const item of result.items) {
        expect(item.kind).toBe('inline')
        expect(item.schema).toEqual(RuntimeSchemaRefs.StoredRecord)
        const value = (item as Loose).value
        expect(Object.keys(value).sort()).toEqual(['meta', 'owner', 'value'])
        expect(value.meta.schema).not.toEqual(item.schema)
        expect((item as Loose).digest).toBe(canonicalJsonDigest(value))
      }
      // the service's own members carry no trust flags (record bodies are not inspected)
      const flags = /^(trusted|current|ready|verified|authorized)$/
      const own = [
        ...Object.keys(reply.value),
        ...Object.keys(reply.value.output),
        ...Object.keys(result),
        ...result.items.flatMap((item) => Object.keys(item)),
        ...result.items.flatMap((item) => Object.keys((item as Loose).value)),
        ...result.items.flatMap((item) => Object.keys((item as Loose).value.meta)),
      ]
      expect(own.filter((key) => flags.test(key))).toEqual([])
    })
  }, 120_000)

  it('refuses records.filter.runId, unknown keys, other collections and other methods by name', async () => {
    await withService(async ({ native, service }) => {
      const caller = sessionCaller(native)
      const snapshot = await openSnapshot(native, service)
      for (const filter of [{ runId: FIXTURE_RUN }, { commitId: 'c' }, { states: ['x'] }, { fromSeq: 0 }])
        expect((await service.query(wire(snapshot, 'records', filter), caller)).error?.detailCode).toBe(
          'state_request',
        )
      for (const collection of [
        'events',
        'integrity',
        'outbox',
        'record-versions',
        'mutation-manifests',
        'commit-side-entries',
      ])
        expect((await service.query(wire(snapshot, collection), caller)).error?.detailCode).toBe(
          'state_collection',
        )
      expect(
        (await service.query({ ...wire(snapshot, 'records'), method: 'probeCommit' }, caller)).error
          ?.detailCode,
      ).toBe('state_method')
      expect(
        (await service.query({ ...wire(snapshot, 'records'), page: { limit: 1 } }, caller)).error?.detailCode,
      ).toBe('state_request')
      expect(
        (
          await service.query(
            wire(snapshot, 'records', { typeIds: ['agh.runtime/receipt-record@1'] }),
            caller,
          )
        ).error?.detailCode,
      ).toBe('state_type')
      expect(pageOf(await service.query(wire(snapshot, 'records', { typeIds: [] }), caller)).items).toEqual(
        [],
      )
    })
  }, 120_000)

  it('shows an action caller only its own action, run and binding; the others look absent', async () => {
    await withService(async ({ native, service }) => {
      await commitPreparedActions(native, 3)
      const caller = sessionCaller(native)
      const opened = await openSnapshot(native, service, caller)
      const actions = pageOf(await service.query(wire(opened, 'actions', { runId: FIXTURE_RUN }), caller))
        .items as Loose[]
      const [mine, sibling] = actions.map((item) => item.value.actionId as string)
      if (!mine || !sibling) throw Error('fixture actions missing')
      const mineCaller = callerWith(native, actionScope(native, mine))
      const reader = service.reader
      const snapshot = (await reader.open(mineCaller, null)).value
      expect((await reader.getAction(mineCaller, snapshot, mine)).value?.stored.value.actionId).toBe(mine)
      const hidden = await reader.getAction(mineCaller, snapshot, sibling)
      const missing = await reader.getAction(mineCaller, snapshot, 'no-such-action')
      expect(hidden).toEqual(missing)
      expect(hidden.value).toBeNull()
      expect((await reader.getRun(mineCaller, snapshot, FIXTURE_RUN)).value).not.toBeNull()
      expect((await reader.getRunBinding(mineCaller, snapshot, FIXTURE_RUN)).value).not.toBeNull()
      expect(pageOf(await service.query(wire(snapshot, 'records'), mineCaller)).items).toHaveLength(3)
      // a read-only point result carries no trust flags either
      const run = (await reader.getRun(mineCaller, snapshot, FIXTURE_RUN)).value
      expect(Object.keys(run).sort()).toEqual(['ledgerSeq', 'stored', 'valueDigest', 'versionDigest'])
    })
  }, 120_000)

  it('gives one identical refusal for a foreign session, a foreign principal and a revoked identity', async () => {
    await withService(async ({ native, service }) => {
      const caller = sessionCaller(native)
      const snapshot = await openSnapshot(native, service, caller)
      const strange = { ...caller, principalRef: 'someone-else' }
      const foreignOpen = await service.open(openRequest(native), strange)
      const otherSession = await service.open(openRequest(native, 'other-session'), caller)
      const foreignScan = await service.query(wire(snapshot, 'records'), strange)
      expect(strip(foreignOpen)).toEqual({
        ok: false,
        code: 'denied',
        detail: 'state_scope',
        message: strip(otherSession).message,
      })
      expect(strip(otherSession)).toEqual(strip(foreignOpen))
      expect(strip(foreignScan)).toEqual(strip(foreignOpen))
      native.testBridge.revoke()
      expect(strip(await service.query(wire(snapshot, 'records'), caller))).toEqual(strip(foreignOpen))
    })
  }, 120_000)

  it('refuses a forged snapshot field and treats an unknown snapshot as a read to repeat', async () => {
    await withService(async ({ native, service }) => {
      const caller = sessionCaller(native)
      const snapshot = await openSnapshot(native, service, caller)
      const forged = { ...snapshot, expiresAt: '2099-01-01T00:00:00Z' }
      expect((await service.query(wire(forged, 'records'), caller)).error?.detailCode).toBe('state_snapshot')
      const unknown = { ...snapshot, snapshotId: 'minted-elsewhere' }
      expect((await service.query(wire(unknown, 'records'), caller)).error?.detailCode).toBe(
        'resync_required',
      )
      expect(pageOf(await service.query(wire({ ...snapshot }, 'records'), caller)).items).toHaveLength(2)
    })
  }, 120_000)

  it('serves >500 records in byte-bounded pages from one fixed snapshot and replays a lost reply', async () => {
    await withService(async ({ native, service }) => {
      await commitPreparedActions(native, 520)
      const caller = sessionCaller(native)
      const snapshot = await openSnapshot(native, service, caller)
      const seen = new Set<string>()
      let cursor: string | null = null
      let pages = 0
      do {
        const reply: Loose = await service.query(wire(snapshot, 'records', {}, cursor), caller)
        const result = pageOf(reply)
        expect(Buffer.byteLength(JSON.stringify(reply.value.output.value), 'utf8')).toBeLessThanOrEqual(
          262_144,
        )
        for (const item of result.items) seen.add((item as Loose).value.meta.recordId)
        if (cursor !== null) {
          const replay: Loose = await service.query(wire(snapshot, 'records', {}, cursor), caller)
          expect(replay.value.output.value).toEqual(reply.value.output.value)
        }
        cursor = result.nextCursor
        pages++
      } while (cursor !== null)
      expect(seen.size).toBe(522)
      expect(pages).toBeGreaterThanOrEqual(2)
    })
  }, 300_000)

  it('fills pages by bytes when items are large and keeps a continuation after each page', async () => {
    await withService(async ({ native, service }) => {
      await commitPreparedActions(native, 6, undefined, 'x'.repeat(100_000))
      const caller = sessionCaller(native)
      const snapshot = await openSnapshot(native, service, caller)
      let cursor: string | null = null
      let pages = 0
      let items = 0
      do {
        const reply: Loose = await service.query(
          wire(snapshot, 'actions', { runId: FIXTURE_RUN }, cursor),
          caller,
        )
        const result = pageOf(reply)
        expect(Buffer.byteLength(JSON.stringify(reply.value.output.value), 'utf8')).toBeLessThanOrEqual(
          262_144,
        )
        items += result.items.length
        if (result.nextCursor !== null) expect(result.items.length).toBeGreaterThanOrEqual(1)
        cursor = result.nextCursor
        pages++
      } while (cursor !== null)
      expect(items).toBe(6)
      expect(pages).toBeGreaterThanOrEqual(3)
    })
  }, 300_000)

  it('admits at most 128 simultaneous opens and frees the slot of an open cancelled in flight', async () => {
    await withService(async ({ native, service }) => {
      const caller = sessionCaller(native)
      const open = (c = caller) => service.open(openRequest(native), c)
      const settled = await Promise.all(Array.from({ length: 129 }, () => open()))
      expect(settled.filter((r: Loose) => r.ok)).toHaveLength(128)
      for (const r of settled.filter((r: Loose) => r.ok)) service.reader.release(r.value.snapshot)
      const controller = new AbortController()
      const pending = open(callerWith(native, sessionScope(native), controller.signal))
      controller.abort()
      const cancelled = await pending
      expect(cancelled.ok).toBe(false)
      expect(cancelled.error.detailCode).toBe('state_cancelled')
      const again = await Promise.all(Array.from({ length: 128 }, () => open()))
      expect(again.filter((r: Loose) => r.ok)).toHaveLength(128)
    })
  }, 300_000)

  it('releases the snapshot the owner just opened when the caller was cancelled before registration', async () => {
    // A bridge whose check ignores abort, so only the service's own signal check can notice it.
    const blind = (bridge: StateReadBridge): StateReadBridge => ({
      ownedSessions: (caller, page) => bridge.ownedSessions(caller, page),
      grant(caller, requested) {
        const grant = bridge.grant(caller, requested)
        if (!grant) return grant
        return {
          ...grant,
          check() {
            try {
              grant.check()
            } catch (error) {
              if (!caller.signal.aborted) throw error
            }
          },
        }
      },
    })
    await withService(async ({ native, service }) => {
      const open = (c = sessionCaller(native)) => service.open(openRequest(native), c)
      for (let round = 0; round < 3; round++) {
        const controller = new AbortController()
        const pending = Promise.all(
          Array.from({ length: 64 }, () => open(callerWith(native, sessionScope(native), controller.signal))),
        )
        controller.abort()
        expect((await pending).every((r: Loose) => !r.ok)).toBe(true)
      }
      const again = await Promise.all(Array.from({ length: 128 }, () => open()))
      expect(again.filter((r: Loose) => r.ok)).toHaveLength(128)
    }, blind)
  }, 300_000)

  it('writes nothing while reading', async () => {
    await withService(async ({ native, service }) => {
      const caller = sessionCaller(native)
      const before = native.fixture.db.prepare('SELECT total_changes() n').get()?.n
      const snapshot = await openSnapshot(native, service, caller)
      await service.query(wire(snapshot, 'records'), caller)
      await service.reader.getRun(caller, snapshot, FIXTURE_RUN)
      expect(native.fixture.db.prepare('SELECT total_changes() n').get()?.n).toBe(before)
    })
  }, 120_000)

  it('does not read a record type outside the readable table', async () => {
    await withService(async ({ native, service }) => {
      const caller = sessionCaller(native)
      const snapshot = await openSnapshot(native, service, caller)
      const refused = await service.reader.get(caller, snapshot, 'run:x', {
        typeId: 'agh.runtime/receipt-record@1',
        revision: 1,
        digest: '0'.repeat(64),
      })
      expect(refused.error?.detailCode).toBe('state_type')
    })
  }, 120_000)
})

describe.skipIf(typeof process.getuid !== 'function')('State query service construction and close', () => {
  it('never hands the query service a raw database handle or an identity module', async () => {
    const native = await originalNativeFixture()
    const foreign = new DatabaseSync(native.file)
    try {
      const base = {
        owner: native.reader,
        bridge: native.bridge,
        authority: native.authority,
        now: native.now,
      }
      expect(() => createStateQueryService(base)).not.toThrow()
      expect(() =>
        createStateQueryService({
          ...base,
          // @ts-expect-error a database handle is not part of the service's input
          database: native.fixture.db,
        }),
      ).toThrow()
      expect(() =>
        createStateQueryService({
          ...base,
          // @ts-expect-error an identity module is not part of the service's input
          identity: native.identity,
        }),
      ).toThrow()
      const service = createStateQueryService(base)
      expect(Object.keys(service).sort()).toEqual(['close', 'open', 'query', 'reader'])
      expect(JSON.stringify(Object.keys(service))).not.toMatch(/database|identity|connection/i)
      expect(Object.keys(service.reader).join()).not.toMatch(/database|identity|connection/i)
    } finally {
      foreign.close()
      await native.reader.close()
      native.identity.close()
      await native.fixture.close()
      rmSync(native.directory, { recursive: true, force: true })
    }
  }, 60_000)

  it('is not constructed or imported by any production path', () => {
    const root = join(import.meta.dirname, '../../src')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (
          name.endsWith('.ts') &&
          !path.endsWith('state/query-service.ts') &&
          /query-service\.js|createStateQueryService/.test(readFileSync(path, 'utf8'))
        )
          offenders.push(path)
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })

  it('rejects new calls once closing and drains in-flight reads before State may close', async () => {
    await withService(async ({ native, service }) => {
      const caller = sessionCaller(native)
      const snapshot = await openSnapshot(native, service, caller)
      const hold = holdStateReads(native)
      try {
        const inFlight = service.query(wire(snapshot, 'records'), caller)
        const closing = service.close()
        const grantsAtClose = native.testBridge.calls.grant
        expect((await service.query(wire(snapshot, 'records'), caller)).error?.detailCode).toBe(
          'resync_required',
        )
        expect((await service.open(openRequest(native), caller)).error?.detailCode).toBe('resync_required')
        expect((await service.reader.getRun(caller, snapshot, FIXTURE_RUN)).error?.detailCode).toBe(
          'resync_required',
        )
        expect(native.testBridge.calls.grant).toBe(grantsAtClose) // a closing service asks the bridge for nothing
        let drained = false
        void closing.then(() => {
          drained = true
        })
        await tick()
        expect(drained).toBe(false)
        expect(native.fixture.db.isOpen).toBe(true)
        hold.release()
        expect((await inFlight).ok).toBe(false)
        await closing
        expect(drained).toBe(true)
      } finally {
        hold.release()
      }
      // State closes last; nothing is reading now
      expect(native.fixture.db.isOpen).toBe(true)
    })
  }, 120_000)

  it('refuses reads on the owner once it is closed without touching the database', async () => {
    await withService(async ({ native, service }) => {
      const caller = sessionCaller(native)
      const snapshot = await openSnapshot(native, service, caller)
      await native.reader.close()
      const before = native.fixture.db.prepare('SELECT total_changes() n').get()?.n
      expect((await service.query(wire(snapshot, 'records'), caller)).ok).toBe(false)
      expect(native.fixture.db.prepare('SELECT total_changes() n').get()?.n).toBe(before)
    })
  }, 120_000)
})

describe.skipIf(typeof process.getuid !== 'function')('State query service bridge consultation', () => {
  it('consults the bridge on every page and every point read, not only at open', async () => {
    await withService(async ({ native, service }) => {
      await commitPreparedActions(native, 2)
      const caller = sessionCaller(native)
      const snapshot = await openSnapshot(native, service, caller)
      const calls = native.testBridge.calls
      const first: Loose = await service.query(wire(snapshot, 'records', {}, null, 1), caller)
      const afterFirst = calls.check
      const cursor = pageOf(first).nextCursor
      expect(cursor).not.toBeNull()
      const second: Loose = await service.query(wire(snapshot, 'records', {}, cursor, 1), caller)
      expect(second.ok).toBe(true)
      expect(calls.check).toBeGreaterThan(afterFirst)
      const grants = calls.grant
      const beforePoint = calls.check
      expect((await service.reader.getRun(caller, snapshot, FIXTURE_RUN)).ok).toBe(true)
      expect(calls.check).toBeGreaterThan(beforePoint)
      expect(calls.grant).toBeGreaterThan(grants)
      native.testBridge.revoke()
      expect((await service.query(wire(snapshot, 'records', {}, cursor, 1), caller)).error?.detailCode).toBe(
        'state_scope',
      )
      expect((await service.reader.getRun(caller, snapshot, FIXTURE_RUN)).error?.detailCode).toBe(
        'state_scope',
      )
    })
  }, 120_000)

  it('checks the caller current grant before a page and again after the read', async () => {
    const toggle = currentGrantToggle()
    await withService(async ({ native, service }) => {
      const caller = sessionCaller(native)
      const snapshot = await openSnapshot(native, service, caller)
      toggle.state.broken = true
      expect((await service.query(wire(snapshot, 'records'), caller)).error?.detailCode).toBe('state_scope')
      expect((await service.reader.getRun(caller, snapshot, FIXTURE_RUN)).error?.detailCode).toBe(
        'state_scope',
      )
      toggle.state.broken = false
      expect((await service.query(wire(snapshot, 'records'), caller)).ok).toBe(true)
      // broken before the call: refused without starting a State read (a held read would block)
      const early = holdStateReads(native)
      toggle.state.broken = true
      const refusedPage = await Promise.race([service.query(wire(snapshot, 'records'), caller), tick()])
      const refusedPoint = await Promise.race([service.reader.getRun(caller, snapshot, FIXTURE_RUN), tick()])
      expect((refusedPage as Loose)?.error?.detailCode).toBe('state_scope')
      expect((refusedPoint as Loose)?.error?.detailCode).toBe('state_scope')
      toggle.state.broken = false
      early.release()
      // the same snapshot offered under another authorization or window is refused
      toggle.state.otherAuthority = true
      expect((await service.query(wire(snapshot, 'records'), caller)).error?.detailCode).toBe('state_scope')
      expect((await service.reader.getRun(caller, snapshot, FIXTURE_RUN)).error?.detailCode).toBe(
        'state_scope',
      )
      toggle.state.otherAuthority = false
      // broken only while the read is in flight: the post-read check is the one that catches it
      const hold = holdStateReads(native)
      const page = service.query(wire(snapshot, 'records'), caller)
      const point = service.reader.getRun(caller, snapshot, FIXTURE_RUN)
      toggle.state.broken = true
      hold.release()
      expect((await page).error?.detailCode).toBe('state_scope')
      expect((await point).error?.detailCode).toBe('state_scope')
    }, toggle.wrap)
  }, 120_000)

  it('catches a revoke committed during a read by the post-read check, not by snapshot visibility', async () => {
    await withService(async ({ native, service }) => {
      const caller = sessionCaller(native)
      const snapshot = await openSnapshot(native, service, caller)
      const hold = holdStateReads(native)
      const pending = service.query(wire(snapshot, 'records'), caller)
      const point = service.reader.getRun(caller, snapshot, FIXTURE_RUN)
      native.testBridge.revoke() // committed outside the read; the read in flight cannot see it
      hold.release()
      expect((await pending).error?.detailCode).toBe('state_scope')
      expect((await point).error?.detailCode).toBe('state_scope')
    })
  }, 120_000)
})

describe.skipIf(typeof process.getuid !== 'function')('test bridge adapter binds the local principal', () => {
  it('grants only the verified local principal its own session and own window', async () => {
    const native = await originalNativeFixture()
    try {
      const { bridge } = native
      const runtime = callerWith(native, native.scope)
      const session = callerWith(native, sessionScope(native))
      expect(bridge.grant(runtime, FIXTURE_SESSION)?.window).toEqual({ kind: 'session' })
      expect(bridge.grant(runtime, null)).toBeNull()
      expect(bridge.grant(session, 'other-session')).toBeNull()
      expect(bridge.grant(session, null)?.sessionId).toBe(FIXTURE_SESSION)
      const run = callerWith(native, runScope(native))
      expect(bridge.grant(run, null)?.window).toEqual({ kind: 'run', runId: FIXTURE_RUN })
      const action = callerWith(native, actionScope(native, 'a1'))
      expect(bridge.grant(action, null)?.window).toEqual({
        kind: 'action',
        runId: FIXTURE_RUN,
        actionId: 'a1',
      })
      // not any runtime context: another principal, another authorization, another runtime
      expect(bridge.grant({ ...session, principalRef: 'someone-else' }, null)).toBeNull()
      expect(bridge.grant({ ...session, authorizationRef: 'forged' }, null)).toBeNull()
      expect(
        bridge.grant(
          { ...session, scope: { ...sessionScope(native), runtimeId: 'another-runtime' } as ScopeRef },
          null,
        ),
      ).toBeNull()
      expect(bridge.ownedSessions(session, { after: null, limit: 10 })).toEqual({
        sessionIds: [FIXTURE_SESSION],
        next: null,
      })
      expect(
        bridge.ownedSessions({ ...session, principalRef: 'someone-else' }, { after: null, limit: 10 }),
      ).toBeNull()
    } finally {
      await native.reader.close()
      native.identity.close()
      await native.fixture.close()
      rmSync(native.directory, { recursive: true, force: true })
    }
  }, 60_000)

  it('throws from check() on revocation, a lost owner mapping, a closed connection and abort', async () => {
    for (const cause of ['revoke', 'mapping', 'generation', 'abort'] as const) {
      const native = await originalNativeFixture()
      try {
        const controller = new AbortController()
        const caller = callerWith(native, sessionScope(native), controller.signal)
        const grant = native.bridge.grant(caller, null)
        if (!grant) throw Error('grant refused')
        expect(() => grant.check()).not.toThrow()
        if (cause === 'revoke') native.testBridge.revoke()
        if (cause === 'mapping') native.testBridge.dropSessionOwner(FIXTURE_SESSION)
        if (cause === 'generation') native.identity.close()
        if (cause === 'abort') controller.abort()
        expect(() => grant.check(), cause).toThrow()
        if (cause !== 'abort') expect(native.bridge.grant(caller, null), cause).toBeNull()
      } finally {
        await native.reader.close()
        native.identity.close()
        await native.fixture.close()
        rmSync(native.directory, { recursive: true, force: true })
      }
    }
  }, 120_000)
})
