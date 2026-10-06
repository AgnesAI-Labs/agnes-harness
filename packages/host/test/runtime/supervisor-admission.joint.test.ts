import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDefaultSupervisorFactory,
  type RecalledTicket,
  type SupervisorAdmissionPort,
} from '@agnes/core'
import type { Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import { admissionFixtureInput } from '../../../extension-api/testkit/runtime/contracts/assembly-admission.js'
import {
  supervisorConfig,
  supervisorDescriptor,
  supervisorInput,
} from '../../../extension-api/testkit/runtime/contracts/supervisor.js'
import { createTestServiceContainer } from '../../../extension-api/testkit/runtime/harness.js'
import { journalData } from '../../src/runtime/assembly/maintenance-journal.js'
import { openJointAdmission } from './fixtures/assembly-admission-joint.js'
import { fixtureRef } from './fixtures/assembly-maintenance-wire.js'

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value })
const sessionScope = {
  kind: 'session' as const,
  installationId: 'fixture-installation',
  runtimeId: 'fixture-runtime',
  workspaceId: 'fixture-workspace',
  sessionId: 'fixture-session',
}
const loop: W.BindingRef = {
  contract: 'agh.loop',
  logicalName: 'default',
  providerId: 'fixture-loop',
  bindingId: 'fixture-loop-binding',
}
const supervisorBinding: W.BindingRef = {
  contract: 'agh.supervisor',
  logicalName: 'default',
  providerId: 'agh.default/supervisor',
  bindingId: 'supervisor-joint',
}

type Joint = Awaited<ReturnType<typeof openJointAdmission>>
/** Test-side stand-in for the platform's recall seam: it only reads the maintenance journal. */
function adapter(fixture: Joint, hold: { next: boolean }): SupervisorAdmissionPort {
  const toTicket = (envelope: NonNullable<ReturnType<Joint['maintenance']['get']>>): RecalledTicket => {
    const data = journalData(envelope, 'admission-ticket')
    return {
      admission: data.admission as W.RunAdmission,
      stateAuthorityRef: data.stateAuthorityRef as W.StateAuthorityRef,
      runKey: String(data.runKey),
      grantRef: String(data.grantRef),
    }
  }
  return {
    async coordinate(draft, context) {
      if (!hold.next) return fixture.coordinator.coordinate(draft, context)
      hold.next = false
      // A lost createRun answer: the ticket is issued and the pin held, but State never saw createRun.
      const issued = await fixture.tickets.issue(draft, context)
      return issued.ok ? ok({ state: 'absent' }) : issued
    },
    cancel: (ticketId, fingerprint, context) => fixture.coordinator.cancel(ticketId, fingerprint, context),
    async recall(ticketId) {
      const envelope = fixture.maintenance.get(`ticket:${ticketId}`)
      return ok(envelope ? toTicket(envelope) : null)
    },
    async recallByRun(runId) {
      for (const row of fixture.maintenance.inspect().records) {
        if (!row.recordId.startsWith('ticket:')) continue
        const envelope = fixture.maintenance.get(row.recordId)
        if (envelope && toTicket(envelope).admission.runId === runId) return ok(toTicket(envelope))
      }
      return ok(null)
    },
  }
}

it('admits through the real coordinator and State, converges on a retry with zero new writes, refuses a changed request, and cancels before createRun', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-supervisor-admit-'))
  const input = admissionFixtureInput()
  const fixture = await openJointAdmission(directory, input, () => {}, false, undefined, sessionScope)
  try {
    const hold = { next: false }
    const authority = fixture.binding.stateAuthorityAtCreation
    const release = {
      releaseSetId: fixture.binding.releaseSetId,
      runBinding: { ...fixture.binding, providers: [{ binding: loop }] } as never,
      stateAuthorityRef: authority,
      lane: 'foreground',
    }
    let now = Date.parse(input.fixture.now)
    const provider = await createDefaultSupervisorFactory(supervisorDescriptor('agh.default/supervisor'), {
      clock: () => now,
      admission: adapter(fixture, hold),
      releases: { select: async () => ok(release), bound: async () => ok(release) },
      // The owner's own identity gate runs inside State and the coordinator; this port only mirrors it for the gate.
      identity: {
        issue: async () => {
          throw new Error('unused')
        },
        issueRuntime: async () => {
          throw new Error('unused')
        },
        check() {},
        delegationExpiresAt: () => null,
      },
      limits: {
        workflowLifetimeMs: 86_400_000,
        actionDefaultTimeoutMs: 120_000,
        pollMs: 1000,
        leaseTtlMs: 15_000,
        cycleMs: 30_000,
        invocationMs: 5000,
        graceMs: 2000,
        queryAllowance: 64,
      },
    }).create(supervisorConfig(), createTestServiceContainer().dependencies, {
      instanceId: 'supervisor-joint',
      scope: { kind: 'runtime', installationId: 'fixture-installation', runtimeId: 'fixture-runtime' },
      bindingId: supervisorBinding.bindingId,
      signal: new AbortController().signal,
    })
    await provider.ready(fixture.context())
    const admit = (key: string, prompt = 'synthetic') =>
      provider.control?.(
        {
          target: supervisorBinding,
          method: 'admit',
          input: supervisorInput('admit', {
            presetRef: 'fixture-preset-v2',
            inputRef: fixtureRef({ prompt }),
            idempotencyKey: key,
          }),
        },
        fixture.context(),
      )
    const cancel = (runRef: W.RunRef, reason: string) =>
      provider.control?.(
        { target: supervisorBinding, method: 'cancel', input: supervisorInput('cancel', { runRef, reason }) },
        fixture.context(),
      )

    // 1. first admit creates the run and reports the Loop binding
    const first = await admit('key-1')
    expect(first?.ok && first.value.kind === 'inline' && first.value.value).toMatchObject({
      bindingRef: loop,
    })
    expect(fixture.inspect().created).toHaveLength(1)

    // 2. a lost-response retry an hour later converges: same answer, zero new writes
    const settled = fixture.inspect()
    now += 3_600_000
    expect(await admit('key-1')).toEqual(first)
    expect(fixture.inspect()).toEqual(settled)

    // 3. the same key with another request is refused and writes nothing
    const changed = await admit('key-1', 'another prompt')
    expect(!changed?.ok && changed?.error).toMatchObject({
      code: 'conflict',
      detailCode: 'idempotency_conflict',
    })
    expect(fixture.inspect()).toEqual(settled)

    // 4. cancel before createRun: tombstone, a repeat returns the same pointer, a later admit is cancelled
    // The coordinator's own clock stays frozen at the fixture time, so a ticket issued an hour later would be
    // judged expired; the Supervisor clock returns to it for this step.
    now = Date.parse(input.fixture.now)
    hold.next = true
    const lost = await admit('key-2')
    expect(!lost?.ok && lost?.error).toMatchObject({
      code: 'retryable',
      detailCode: 'supervisor_admission_pending',
    })
    const ticket = [...fixture.maintenance.inspect().records].find(
      (row) =>
        row.recordId.startsWith('ticket:') && row.recordId !== `ticket:${journalRunTicket(fixture, first)}`,
    )
    expect(ticket).toBeDefined()
    const stored = journalData(fixture.maintenance.get(String(ticket?.recordId)) as never, 'admission-ticket')
    const runRef: W.RunRef = {
      runId: String((stored.admission as W.RunAdmission).runId),
      session: { sessionId: sessionScope.sessionId, authority },
    }
    const stopped = await cancel(runRef, 'stop')
    expect(stopped?.ok).toBe(true)
    expect(await cancel(runRef, 'another reason')).toEqual(stopped)
    const afterTombstone = await admit('key-2')
    expect(!afterTombstone?.ok && afterTombstone?.error).toMatchObject({
      code: 'cancelled',
      detailCode: 'supervisor_admission_cancelled',
    })
    expect(fixture.inspect().cancelled).toHaveLength(1)
    expect(fixture.inspect().created).toHaveLength(1)

    // 5. a copied context is refused by the identity owner and nothing is written
    const before = fixture.inspect()
    const copied = await provider.control?.(
      {
        target: supervisorBinding,
        method: 'admit',
        input: supervisorInput('admit', {
          presetRef: 'fixture-preset-v2',
          inputRef: fixtureRef({ prompt: 'synthetic' }),
          idempotencyKey: 'key-3',
        }),
      },
      { ...fixture.context() },
    )
    expect(copied?.ok).toBe(false)
    expect(fixture.inspect()).toEqual(before)
  } finally {
    await fixture.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 60_000)

/** The ticket record id of an earlier admit, so step 4 can pick the other one. */
function journalRunTicket(fixture: Joint, reply: Outcome<W.DataRef> | undefined): string {
  const runId =
    reply?.ok && reply.value.kind === 'inline' ? String((reply.value.value as { runId: string }).runId) : ''
  for (const row of fixture.maintenance.inspect().records) {
    if (!row.recordId.startsWith('ticket:')) continue
    const data = journalData(fixture.maintenance.get(row.recordId) as never, 'admission-ticket')
    if ((data.admission as W.RunAdmission).runId === runId) return row.recordId.slice('ticket:'.length)
  }
  return ''
}
