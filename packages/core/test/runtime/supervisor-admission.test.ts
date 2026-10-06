import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { createRestrictedSupervisorAdmission } from '../../../extension-api/testkit/runtime/contracts/supervisor.js'
import {
  admit as defaultAdmit,
  cancelAdmission as defaultCancel,
} from '../../src/runtime/supervisor/admission.js'
import type {
  PublishedRelease,
  SupervisorAdmissionPort,
  SupervisorDeployment,
} from '../../src/runtime/supervisor/ports.js'

const authority = { authorityId: 'auth-1', tenantId: 'tenant', authorityEpoch: 1 }
const loop: W.BindingRef = {
  contract: 'agh.loop',
  logicalName: 'default',
  providerId: 'agh.default/loop',
  bindingId: 'loop-binding',
}
const release: PublishedRelease = {
  releaseSetId: 'release-1',
  stateAuthorityRef: authority,
  lane: 'main',
  runBinding: { bindingId: 'run-binding-1', providers: [{ binding: loop }] } as unknown as W.RunBinding,
}
const DAY = 86_400_000
const inputRef = (value: string): W.DataRef =>
  ({
    kind: 'inline',
    schema: { typeId: 't/x@1', revision: 1, digest: 'a'.repeat(64) },
    value,
    bytes: value.length + 2,
    digest: canonicalJsonDigest(value),
  }) as W.DataRef
function scopeOf(kind: 'session' | 'runtime', sessionId = 'session-1') {
  return kind === 'runtime'
    ? { kind: 'runtime', installationId: 'i', runtimeId: 'r' }
    : { kind: 'session', installationId: 'i', runtimeId: 'r', tenantId: 't', workspaceId: 'w', sessionId }
}
function context(
  over: { kind?: 'session' | 'runtime'; signal?: AbortSignal; sessionId?: string } = {},
): CallContext {
  return {
    principalRef: 'principal',
    scope: scopeOf(over.kind ?? 'session', over.sessionId),
    bindingId: 'supervisor-binding',
    invocationId: 'inv',
    deadline: '2100-01-01T00:00:00.000Z',
    traceRef: 'trace',
    authorizationRef: 'grant-1',
    signal: over.signal ?? new AbortController().signal,
  } as unknown as CallContext
}
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value })

function deployment(over: Partial<SupervisorDeployment> & { revoked?: { at: number } } = {}) {
  const fake = createRestrictedSupervisorAdmission()
  const calls = { select: 0, bound: 0, checks: 0 }
  let now = Date.parse('2026-10-05T00:00:00.000Z')
  const revoked = over.revoked ?? { at: Infinity }
  const d: SupervisorDeployment = {
    clock: () => now,
    admission: fake.port as never,
    releases: {
      async select() {
        calls.select += 1
        return ok(release)
      },
      async bound() {
        calls.bound += 1
        return ok(release)
      },
    },
    identity: {
      async issue() {
        throw new Error('not used')
      },
      async issueRuntime() {
        throw new Error('not used')
      },
      check() {
        calls.checks += 1
        if (calls.checks >= revoked.at) throw new Error('revoked')
      },
      delegationExpiresAt: () => null,
    },
    limits: {
      workflowLifetimeMs: 30 * DAY,
      actionDefaultTimeoutMs: 120_000,
      pollMs: 1000,
      leaseTtlMs: 15_000,
    },
    ...over,
  }
  return {
    d,
    fake,
    calls,
    advance: (ms: number) => {
      now += ms
    },
  }
}
const spec = (key = 'idem-1', value = 'hello'): W.NewRunSpec => ({
  presetRef: 'preset-1',
  inputRef: inputRef(value),
  idempotencyKey: key,
})
const code = (result: Outcome<unknown>) =>
  result.ok ? 'ok' : `${result.error.code}/${result.error.detailCode}`

// The reference is loaded by path so core never depends on it; both run the very same cases.
const reference = (await import(
  new URL('../../../../examples/runtime-reference/src/providers/supervisor-admission.ts', import.meta.url)
    .href
)) as {
  referenceAdmit: (p: never, i: unknown, c: CallContext) => Promise<Outcome<unknown>>
  referenceCancel: (p: never, i: unknown, c: CallContext) => Promise<Outcome<unknown>>
}
const impls = {
  default: { admit: defaultAdmit, cancel: defaultCancel },
  reference: {
    admit: (d: SupervisorDeployment, i: unknown, c: CallContext) =>
      reference.referenceAdmit(d as never, i, c),
    cancel: (d: SupervisorDeployment, i: unknown, c: CallContext) =>
      reference.referenceCancel(d as never, i, c),
  },
}

for (const [name, api] of Object.entries(impls)) {
  describe(`${name}: admit`, () => {
    it('issues once from the published release with the trusted clock and the 30 day lifetime', async () => {
      const f = deployment()
      const reply = await api.admit(f.d, spec(), context())
      expect(reply.ok && reply.value.bindingRef).toEqual(loop)
      const row = [...f.fake.tickets.values()][0]
      expect(row?.draft.admission.admittedAt).toBe('2026-10-05T00:00:00.000Z')
      expect(row?.draft.admission.deadline).toBe('2026-11-04T00:00:00.000Z')
      expect(row?.draft.admission.bindingId).toBe('run-binding-1')
      expect(row?.draft.grantRef).toBe('grant-1')
      expect(f.calls.select).toBe(1)
    })
    it('converges on a lost-response retry: stored admittedAt and deadline, no new select, one ticket', async () => {
      const f = deployment()
      const first = await api.admit(f.d, spec(), context())
      f.advance(3_600_000)
      const retry = await api.admit(f.d, spec(), context())
      expect(retry).toEqual(first)
      expect(f.calls.select).toBe(1)
      expect(f.fake.tickets.size).toBe(1)
      expect(
        f.fake.log
          .filter((line) => line.startsWith('coordinate:'))
          .every((line) => line === 'coordinate:2026-10-05T00:00:00.000Z'),
      ).toBe(true)
    })
    it('refuses the same key with a different request', async () => {
      const f = deployment()
      expect((await api.admit(f.d, spec('idem-1', 'hello'), context())).ok).toBe(true)
      expect(code(await api.admit(f.d, spec('idem-1', 'other'), context()))).toBe(
        'conflict/idempotency_conflict',
      )
      expect(f.fake.tickets.size).toBe(1)
    })
    it('needs a session scope and makes no outward call without one', async () => {
      const f = deployment()
      expect(code(await api.admit(f.d, spec(), context({ kind: 'runtime' })))).toBe(
        'invalid_input/supervisor_session_required',
      )
      expect(f.fake.log).toEqual([])
      expect(f.calls.select).toBe(0)
    })
    it('creates nothing when authorization is gone before the first call or after an await', async () => {
      const before = deployment({ revoked: { at: 1 } })
      expect(code(await api.admit(before.d, spec(), context()))).toBe('denied/permission_denied')
      expect(before.fake.log).toEqual([])
      const between = deployment({ revoked: { at: 2 } })
      expect(code(await api.admit(between.d, spec(), context()))).toBe('denied/permission_denied')
      expect(between.fake.tickets.size).toBe(0)
      const late = deployment({ revoked: { at: 3 } })
      expect(code(await api.admit(late.d, spec(), context()))).toBe('denied/permission_denied')
      expect(late.fake.tickets.size).toBe(0)
    })
    it('stops on caller abort and keeps the original context object for the coordinator', async () => {
      const seen: CallContext[] = []
      const f = deployment()
      const original = f.d.admission as SupervisorAdmissionPort
      const wrapped: SupervisorAdmissionPort = {
        ...original,
        coordinate: (draft, ctx) => {
          seen.push(ctx)
          return original.coordinate(draft, ctx)
        },
      }
      const ctx = context()
      await api.admit({ ...f.d, admission: wrapped }, spec(), ctx)
      expect(seen[0] === ctx).toBe(true)
      const controller = new AbortController()
      const hung = deployment()
      const slow: SupervisorAdmissionPort = { ...hung.fake.port, recall: () => new Promise(() => {}) }
      const pending = api.admit(
        { ...hung.d, admission: slow },
        spec(),
        context({ signal: controller.signal }),
      )
      controller.abort()
      expect(code(await pending)).toBe('cancelled/cancelled')
    })
    it('refuses an expired delegation and a misconfigured lifetime by name', async () => {
      const expired = deployment()
      const d1 = {
        ...expired.d,
        identity: {
          ...(expired.d.identity as NonNullable<SupervisorDeployment['identity']>),
          delegationExpiresAt: () => '2026-10-04T00:00:00.000Z',
        },
      }
      expect(code(await api.admit(d1, spec(), context()))).toBe('denied/revoked')
      const clamped = deployment()
      const d2 = {
        ...clamped.d,
        identity: {
          ...(clamped.d.identity as NonNullable<SupervisorDeployment['identity']>),
          delegationExpiresAt: () => '2026-10-05T00:10:00.000Z',
        },
      }
      await api.admit(d2, spec(), context())
      expect([...clamped.fake.tickets.values()][0]?.draft.admission.deadline).toBe('2026-10-05T00:10:00.000Z')
      const long = deployment()
      const d3 = {
        ...long.d,
        limits: {
          ...(long.d.limits as NonNullable<SupervisorDeployment['limits']>),
          workflowLifetimeMs: 366 * DAY,
        },
      }
      expect(code(await api.admit(d3, spec(), context()))).toBe('incompatible/supervisor_limits_invalid')
    })
    it('reports an unknown createRun answer as a retry of the same key, never as success', async () => {
      const f = deployment()
      const pending: SupervisorAdmissionPort = {
        ...f.fake.port,
        coordinate: async () => ok({ state: 'absent' }),
      }
      const reply = await api.admit({ ...f.d, admission: pending }, spec(), context())
      expect(code(reply)).toBe('retryable/supervisor_admission_pending')
      expect(!reply.ok && reply.error.retryAdvice.kind).toBe('retry_same_action')
    })
  })

  describe(`${name}: cancel before the run exists`, () => {
    const runRef = (runId: string): W.RunRef => ({ runId, session: { sessionId: 'session-1', authority } })
    async function issued() {
      const f = deployment()
      // Issue a ticket whose createRun has not happened yet: coordinate reports absent and State stays empty.
      const ids = await api.admit(
        {
          ...f.d,
          admission: {
            ...f.fake.port,
            coordinate: async (draft) => {
              f.fake.tickets.set(draft.admission.ticketId, {
                draft,
                fingerprint: canonicalJsonDigest(draft as unknown as W.JsonValue),
                state: { state: 'absent' },
              })
              return ok({ state: 'absent' } as W.AdmissionProbe)
            },
          },
        },
        spec(),
        context(),
      )
      const row = [...f.fake.tickets.values()][0]
      return { f, runId: row?.draft.admission.runId as string, ids }
    }
    it('writes the tombstone once and a later createRun reports cancelled', async () => {
      const { f, runId } = await issued()
      const first = await api.cancel(f.d, { runRef: runRef(runId), reason: 'stop' }, context())
      expect(first.ok && first.value.cancellationRef.receiptId).toBe(`tomb-${[...f.fake.tickets.keys()][0]}`)
      const again = await api.cancel(f.d, { runRef: runRef(runId), reason: 'other reason' }, context())
      expect(again).toEqual(first)
      expect([...f.fake.tickets.values()].filter((row) => row.state.state === 'cancelled')).toHaveLength(1)
      expect(code(await api.admit(f.d, spec(), context()))).toBe('cancelled/supervisor_admission_cancelled')
    })
    it('names an existing run as a later slice, an unknown run as not_found and a foreign session as denied', async () => {
      const created = deployment()
      await api.admit(created.d, spec(), context())
      const runId = [...created.fake.tickets.values()][0]?.draft.admission.runId as string
      expect(code(await api.cancel(created.d, { runRef: runRef(runId), reason: 'x' }, context()))).toBe(
        'incompatible/supervisor_state_command_unavailable',
      )
      expect([...created.fake.tickets.values()].every((row) => row.state.state === 'created')).toBe(true)
      expect(
        code(
          await api.cancel(
            created.d,
            {
              runRef: {
                runId,
                session: { sessionId: 'session-1', authority: { ...authority, authorityEpoch: 2 } },
              },
              reason: 'x',
            },
            context(),
          ),
        ),
      ).toBe('invalid_input/not_found')
      expect(
        code(await api.cancel(created.d, { runRef: runRef('run-unknown'), reason: 'x' }, context())),
      ).toBe('invalid_input/not_found')
      expect(
        code(
          await api.cancel(
            created.d,
            { runRef: { runId, session: { sessionId: 'session-2', authority } }, reason: 'x' },
            context(),
          ),
        ),
      ).toBe('denied/supervisor_scope_session')
    })
    it('does not cancel when authorization is already revoked', async () => {
      const { f, runId } = await issued()
      const revoked = deployment({ revoked: { at: 1 } })
      const d = { ...revoked.d, admission: f.fake.port }
      expect(code(await api.cancel(d, { runRef: runRef(runId), reason: 'x' }, context()))).toBe(
        'denied/permission_denied',
      )
      expect(f.fake.log.includes('cancelAdmission')).toBe(false)
    })
  })
}
