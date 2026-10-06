import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommitGuard } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { admissionFixtureInput } from '../../../extension-api/testkit/runtime/contracts/assembly-admission.js'
import { openJointAdmission } from './fixtures/assembly-admission-joint.js'
import { fixtureRef } from './fixtures/assembly-maintenance-wire.js'

type Joint = Awaited<ReturnType<typeof openJointAdmission>>
type Held = { release(): Promise<void> }

const directories: string[] = []
const joints: Joint[] = []
const claims: Held[] = []
afterEach(async () => {
  for (const claim of claims.splice(0)) await claim.release()
  for (const joint of joints.splice(0)) await joint.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const SESSION = 'fixture-session'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function setup(options: { createRun?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-writer-lease-'))
  directories.push(directory)
  const input = admissionFixtureInput()
  let now = Date.parse(input.fixture.now)
  const joint = await openJointAdmission(directory, input, undefined, false, () => now)
  joints.push(joint)
  if (options.createRun !== false) {
    const created = await joint.coordinator.coordinate(joint.draft(), joint.context())
    if (!(created.ok && created.value.state === 'created')) throw Error('run was not created')
  }
  const authority = joint.binding.stateAuthorityAtCreation
  const { store } = joint
  const acquire = async (
    timing: { ttlMs?: number; heartbeatMs?: number; writerId?: string } = {},
    context = joint.context(),
  ) => {
    const result = await store.acquireWriter(SESSION, context, timing)
    if (result.ok) claims.push(result.value)
    return result
  }
  const lease = () =>
    joint.db
      .prepare(
        'SELECT writer_id,writer_epoch,lease_until,last_writer_epoch FROM runtime_leases WHERE scope_id=?',
      )
      .get(SESSION) as {
      writer_id: string | null
      writer_epoch: number | null
      lease_until: number | null
      last_writer_epoch: number
    }
  const events = () => Number(joint.db.prepare('SELECT count(*) AS n FROM events').get()?.n)
  let counter = 0
  /** One idle run step under a claim; State accepts it only while the claim's lease is the live one. */
  async function commitAs(claim: { writerId: string; writerEpoch: number }) {
    const run = joint.db
      .prepare(
        "SELECT json_extract(b.value_json,'$.revision') AS revision FROM runtime_record_heads h JOIN runtime_version_bodies b ON b.record_id=h.record_id AND b.record_revision=h.record_revision WHERE h.record_id='run:fixture-run-old'",
      )
      .get()
    const revision = Number(run?.revision)
    const invocationId = `invocation-${++counter}`
    await joint.state.admitInvocation({
      requestId: `admit-${counter}`,
      runId: 'fixture-run-old',
      targetActionId: null,
      baseRevision: revision,
      bindingId: joint.binding.bindingId,
      writerEpoch: claim.writerEpoch,
      invocationId,
      deadline: '2027-01-01T00:00:00Z',
      queryAllowance: 0,
    })
    await joint.state.closeInvocation({
      requestId: `close-${counter}`,
      invocationId,
      state: 'prepared',
      readGuards: [],
      domainReads: [],
      unresolvedInflightIds: [],
      observedQueryCount: 0,
    })
    const guard: CommitGuard = {
      authority,
      sessionId: SESSION,
      runId: 'fixture-run-old',
      writerId: claim.writerId,
      writerEpoch: claim.writerEpoch,
      expectedRunRevision: revision,
      bindingId: joint.binding.bindingId,
      invocationId,
      readGuards: [],
      queryUsage: null,
    }
    return joint.state.advanceRun({
      commitId: `step-${counter}`,
      guard,
      transition: {
        expectedRevision: revision,
        continuation: {
          namespace: 'agh.test',
          codecVersion: '1',
          data: fixtureRef({ counter }),
          provenance: { sourceRefs: [], producer: stateBinding(), trustLabels: [] },
          createdAt: input.fixture.now,
          references: [],
        },
        consumeSignals: [],
        actions: [],
        next: { kind: 'continue' },
      },
    })
  }
  const stateBinding = () => ({
    bindingId: joint.binding.bindingId,
    contract: 'agh.state',
    logicalName: 'default',
    providerId: 'fixture-state',
  })
  return {
    joint,
    store,
    acquire,
    lease,
    events,
    commitAs,
    authority,
    advance: (ms: number) => {
      now += ms
    },
    now: () => now,
    ok<T>(outcome: { ok: true; value: T } | { ok: false; error: unknown }): T {
      if (!outcome.ok) throw Error(JSON.stringify(outcome.error))
      return outcome.value
    },
  }
}

describe('writer.acquire', () => {
  it('takes the lease and State accepts a commit under the claim', async () => {
    const f = await setup()
    const claim = f.ok(await f.acquire({ ttlMs: 1000, heartbeatMs: 3_600_000, writerId: 'supervisor-1' }))
    expect(claim).toMatchObject({ writerId: 'supervisor-1', writerEpoch: 1 })
    expect(f.lease()).toMatchObject({
      writer_id: 'supervisor-1',
      writer_epoch: 1,
      lease_until: f.now() + 1000,
      last_writer_epoch: 1,
    })
    await expect(f.commitAs(claim)).resolves.toMatchObject({ runRevision: 1 })
  })

  it('returns the live claim as it is, also for concurrent callers, without a new ledger event', async () => {
    const f = await setup()
    const timing = { ttlMs: 1000, heartbeatMs: 3_600_000 }
    const [a, b, c] = await Promise.all([f.acquire(timing), f.acquire(timing), f.acquire(timing)])
    expect(f.ok(b)).toBe(f.ok(a))
    expect(f.ok(c)).toBe(f.ok(a))
    expect(f.ok(a).writerEpoch).toBe(1)
    const events = f.events()
    expect(f.ok(await f.acquire(timing))).toBe(f.ok(a))
    expect(f.events()).toBe(events)
  })

  it('renews the lease in the background so a long-lived claim stays the live one', async () => {
    const f = await setup()
    const claim = f.ok(await f.acquire({ ttlMs: 1000, heartbeatMs: 20 }))
    const first = f.lease().lease_until
    f.advance(600)
    for (let tries = 0; tries < 100 && f.lease().lease_until === first; tries++) await sleep(20)
    expect(f.lease().lease_until).toBe(f.now() + 1000)
    f.advance(700)
    // 1300 ms after the start: past the first lease length, alive only because it was renewed.
    await sleep(100)
    expect(f.lease()).toMatchObject({ writer_epoch: claim.writerEpoch })
    await expect(f.commitAs(claim)).resolves.toBeDefined()
    expect(f.lease().last_writer_epoch).toBe(1)
  })

  it('reclaims with a higher epoch once the claim ran out, and State refuses the old claim', async () => {
    const f = await setup()
    const timing = { ttlMs: 1000, heartbeatMs: 3_600_000 }
    const old = f.ok(await f.acquire(timing))
    f.advance(1001)
    const next = f.ok(await f.acquire(timing))
    expect(next).not.toBe(old)
    expect(next.writerEpoch).toBe(2)
    expect(f.lease()).toMatchObject({ writer_epoch: 2, last_writer_epoch: 2 })
    await expect(f.commitAs(old)).rejects.toMatchObject({ failure: { code: 'conflict' } })
    await expect(f.commitAs(next)).resolves.toBeDefined()
  })

  it('reclaims after a renewal State refused ended the claim', async () => {
    const f = await setup()
    const old = f.ok(await f.acquire({ ttlMs: 1000, heartbeatMs: 20 }))
    f.advance(5000)
    await sleep(150)
    const next = f.ok(await f.acquire({ ttlMs: 1000, heartbeatMs: 3_600_000 }))
    expect(old.writerEpoch).toBe(1)
    expect(next.writerEpoch).toBe(2)
    await expect(f.commitAs(old)).rejects.toMatchObject({ failure: { code: 'conflict' } })
  })

  it('names a lease held by someone else, and takes it once it ran out', async () => {
    const f = await setup()
    const other = await f.joint.state.open({
      requestId: 'other',
      authority: f.authority,
      sessionId: SESSION,
      mode: 'write',
      writerId: 'other-writer',
      ttlMs: 1000,
    })
    expect(other.claim?.writerEpoch).toBe(1)
    const refused = await f.acquire({ ttlMs: 1000, heartbeatMs: 3_600_000 })
    expect(refused).toMatchObject({ ok: false, error: { code: 'conflict', detailCode: 'writer_lease' } })
    f.advance(1001)
    expect(f.ok(await f.acquire({ ttlMs: 1000, heartbeatMs: 3_600_000 })).writerEpoch).toBe(2)
  })

  it('releases once, stops renewing, and the next acquire takes a new epoch', async () => {
    const f = await setup()
    const claim = f.ok(await f.acquire({ ttlMs: 1000, heartbeatMs: 20 }))
    await claim.release()
    expect(f.lease()).toMatchObject({ writer_id: null, writer_epoch: null, last_writer_epoch: 1 })
    const events = f.events()
    await sleep(150)
    expect(f.events()).toBe(events)
    await expect(claim.release()).resolves.toBeUndefined()
    expect(f.events()).toBe(events)
    const next = f.ok(await f.acquire({ ttlMs: 1000, heartbeatMs: 3_600_000 }))
    expect(next.writerEpoch).toBe(2)
  })

  it('refuses by name an unknown session, bad timing and a cancelled call', async () => {
    const f = await setup({ createRun: false })
    expect(await f.acquire()).toMatchObject({ ok: false, error: { detailCode: 'session_absent' } })
    for (const timing of [{ ttlMs: 0 }, { ttlMs: 1000, heartbeatMs: 0 }, { ttlMs: 1.5 }])
      expect(await f.acquire(timing)).toMatchObject({ ok: false, error: { detailCode: 'lease_timing' } })
    const aborted = new AbortController()
    aborted.abort()
    expect(await f.acquire({}, { ...f.joint.context(), signal: aborted.signal })).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
  })
})
