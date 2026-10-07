import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import type {
  ActionRow,
  RunFacts,
  SupervisorDeployment,
  SupervisorReadPort,
} from '../../src/runtime/supervisor/ports.js'
import {
  inspect as defaultInspect,
  sessionParameters as defaultParameters,
  actionReceipt as defaultReceipt,
} from '../../src/runtime/supervisor/reads.js'

const authority = { authorityId: 'auth-1', tenantId: 'tenant', authorityEpoch: 1 }
const runRef: W.RunRef = { runId: 'run-1', session: { sessionId: 'session-1', authority } }
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value })
const code = (result: Outcome<unknown>) =>
  result.ok ? 'ok' : `${result.error.code}/${result.error.detailCode}`
function context(scope: Record<string, unknown>): CallContext {
  return {
    principalRef: 'p',
    scope,
    bindingId: 'b',
    invocationId: 'i',
    deadline: '2100-01-01T00:00:00.000Z',
    traceRef: 't',
    authorizationRef: 'g',
    signal: new AbortController().signal,
  } as unknown as CallContext
}
const runScope = {
  kind: 'run',
  installationId: 'i',
  runtimeId: 'r',
  tenantId: 't',
  workspaceId: 'w',
  sessionId: 'session-1',
  runId: 'run-1',
}
const actionScope = { ...runScope, kind: 'action', actionId: 'act-parent' }
const sessionScope = {
  kind: 'session',
  installationId: 'i',
  runtimeId: 'r',
  tenantId: 't',
  workspaceId: 'w',
  sessionId: 'session-1',
}
const row = (key: string, id: string, state: W.ActionState = 'running'): ActionRow =>
  ({
    key,
    actionId: id,
    parentActionId: null,
    state,
    obligation: 'mandatory',
    owner: { kind: 'run', id: 'run-1' },
    intentFingerprint: 'f'.repeat(64),
    attempt: null,
    attemptId: null,
    view: { visibility: 'absent', outcome: null },
    receiptId: null,
  }) as ActionRow
const facts = (over: Partial<RunFacts> = {}): RunFacts =>
  ({
    snapshot: 'snap',
    runId: 'run-1',
    sessionId: 'session-1',
    workspaceId: 'w',
    bindingId: 'b',
    revision: 7,
    writerEpoch: 1,
    state: 'waiting',
    deadline: '2100-01-01T00:00:00.000Z',
    input: {} as W.DataRef,
    continuation: null,
    conversation: null,
    cancellation: null,
    wait: null,
    actions: [],
    ...over,
  }) as RunFacts
function deployment(read: Partial<SupervisorReadPort>): SupervisorDeployment {
  return { clock: Date.now, read: read as SupervisorReadPort }
}
const receiptReply = (result: W.SupervisorActionReceiptResult) => async () => ok({ snapshot: 'snap', result })

// The reference is loaded by path so core never depends on it; both run the very same cases.
const reference = (await import(
  new URL('../../../../examples/runtime-reference/src/providers/supervisor-reads.ts', import.meta.url).href
)) as Record<
  'referenceActionReceipt' | 'referenceInspect' | 'referenceSessionParameters',
  (p: never, i: unknown, c: CallContext) => Promise<Outcome<unknown>>
>
type Api = Readonly<{
  actionReceipt(
    d: SupervisorDeployment,
    i: unknown,
    c: CallContext,
  ): Promise<Outcome<W.SupervisorActionReceiptResult>>
  inspect(d: SupervisorDeployment, i: unknown, c: CallContext): Promise<Outcome<W.SupervisorInspectResult>>
  sessionParameters(
    d: SupervisorDeployment,
    i: unknown,
    c: CallContext,
  ): Promise<Outcome<W.SupervisorSessionParametersResult>>
}>
const impls: Record<string, Api> = {
  default: { actionReceipt: defaultReceipt, inspect: defaultInspect, sessionParameters: defaultParameters },
  reference: {
    actionReceipt: (d: SupervisorDeployment, i: unknown, c: CallContext) =>
      reference.referenceActionReceipt(d as never, i, c) as ReturnType<Api['actionReceipt']>,
    inspect: (d: SupervisorDeployment, i: unknown, c: CallContext) =>
      reference.referenceInspect(d as never, i, c) as ReturnType<Api['inspect']>,
    sessionParameters: (d: SupervisorDeployment, i: unknown, c: CallContext) =>
      reference.referenceSessionParameters(d as never, i, c) as ReturnType<Api['sessionParameters']>,
  },
}

for (const [name, api] of Object.entries(impls)) {
  describe(`${name}: actionReceipt`, () => {
    it('derives the namespace from the caller, not the request, and returns the stable key answers', async () => {
      const seen: { runId: string; parentActionId: string | null }[] = []
      const read = {
        receipt: async (_c: CallContext, ns: { runId: string; parentActionId: string | null }) => {
          seen.push(ns)
          return ok({
            snapshot: 'snap',
            result: { actionId: null, receipt: null, visibility: 'absent' as const },
          })
        },
      }
      const d = deployment(read)
      expect((await api.actionReceipt(d, { action: { localKey: 'tool' } }, context(runScope))).ok).toBe(true)
      await api.actionReceipt(d, { action: { localKey: 'child' } }, context(actionScope))
      expect(seen).toEqual([
        { runId: 'run-1', parentActionId: null },
        { runId: 'run-1', parentActionId: 'act-parent' },
      ])
    })
    it('refuses callers that are neither a run nor an action', async () => {
      expect(
        code(await api.actionReceipt(deployment({}), { action: { localKey: 'k' } }, context(sessionScope))),
      ).toBe('denied/supervisor_scope_run')
    })
    it('keeps absent, pending and ready distinct and refuses an inconsistent answer', async () => {
      const view = { actionId: 'act-1' } as unknown as W.ActionResultView
      const run = (result: W.SupervisorActionReceiptResult) =>
        api.actionReceipt(
          deployment({ receipt: receiptReply(result) }),
          { action: { localKey: 'k' } },
          context(runScope),
        )
      expect(code(await run({ actionId: null, receipt: null, visibility: 'absent' }))).toBe('ok')
      expect(code(await run({ actionId: 'act-1', receipt: null, visibility: 'pending' }))).toBe('ok')
      expect(code(await run({ actionId: 'act-1', receipt: view, visibility: 'ready' }))).toBe('ok')
      expect(code(await run({ actionId: 'act-2', receipt: view, visibility: 'ready' }))).toBe(
        'internal/supervisor_peer_mismatch',
      )
      expect(code(await run({ actionId: 'act-1', receipt: view, visibility: 'pending' }))).toBe(
        'internal/supervisor_peer_mismatch',
      )
      expect(code(await run({ actionId: 'act-1', receipt: null, visibility: 'absent' }))).toBe(
        'internal/supervisor_peer_mismatch',
      )
    })
  })

  describe(`${name}: inspect`, () => {
    const wait: W.WaitCondition = {
      anyOf: [
        {
          kind: 'actions',
          mode: 'all',
          readyWhen: 'receipt',
          actions: [{ localKey: 'a' }, { existingActionId: 'act-x' }, { localKey: 'missing' }],
        },
        { kind: 'interaction', interactionId: 'q1' },
        { kind: 'actions', mode: 'any', readyWhen: 'receipt', actions: [{ localKey: 'a' }] },
      ],
    }
    it('lists what the run waits for exactly once and nothing it cannot resolve', async () => {
      const d = deployment({ run: async () => ok(facts({ wait, actions: [row('a', 'act-a')] })) })
      const reply = await api.inspect(d, { runRef }, context(sessionScope))
      expect(reply.ok && reply.value.revision).toBe(7)
      expect(reply.ok && reply.value.waitingRefs).toEqual([
        { kind: 'action', run: runRef, actionId: 'act-a' },
        { kind: 'action', run: runRef, actionId: 'act-x' },
        { kind: 'interaction', value: { interactionId: 'q1' } },
      ])
      expect(reply.ok && reply.value.blockedReason).toBe(null)
    })
    it('reports blocked and unknown-effect drains by name, a healthy wait as null', async () => {
      const blocked = deployment({ run: async () => ok(facts({ state: 'blocked_integrity' })) })
      expect((await api.inspect(blocked, { runRef }, context(sessionScope))).ok && 'x').toBe('x')
      const reply = await api.inspect(blocked, { runRef }, context(sessionScope))
      expect(reply.ok && reply.value.blockedReason).toBe('blocked_integrity')
      const draining = deployment({
        run: async () => ok(facts({ state: 'draining', actions: [row('a', 'act-a', 'unknown')] })),
      })
      const second = await api.inspect(draining, { runRef }, context(sessionScope))
      expect(second.ok && second.value.blockedReason).toBe('unknown_effect')
      // An unknown action does not make a run that is still waiting normally look blocked.
      const waiting = deployment({
        run: async () => ok(facts({ state: 'waiting', actions: [row('a', 'act-a', 'unknown')] })),
      })
      const healthy = await api.inspect(waiting, { runRef }, context(sessionScope))
      expect(healthy.ok && healthy.value.blockedReason).toBe(null)
    })
    it('answers absent and outside-the-window identically, and refuses another session or a swapped run', async () => {
      const none = deployment({ run: async () => ok(null) })
      expect(code(await api.inspect(none, { runRef }, context(sessionScope)))).toBe('invalid_input/not_found')
      expect(
        code(
          await api.inspect(
            none,
            { runRef: { ...runRef, session: { ...runRef.session, sessionId: 'session-2' } } },
            context(sessionScope),
          ),
        ),
      ).toBe('denied/supervisor_scope_session')
      const swapped = deployment({ run: async () => ok(facts({ runId: 'run-other' })) })
      expect(code(await api.inspect(swapped, { runRef }, context(sessionScope)))).toBe(
        'internal/supervisor_peer_mismatch',
      )
    })
  })

  describe(`${name}: sessionParameters`, () => {
    it('forwards the effective revision and refuses another session', async () => {
      const value = { sessionId: 'session-1', revision: 2 } as unknown as W.SessionParameterRevision
      const reply = { value, reference: {} as W.DomainReference }
      const d = deployment({ parameters: async () => ok(reply) })
      expect(code(await api.sessionParameters(d, { runRef }, context(runScope)))).toBe('ok')
      const wrong = deployment({
        parameters: async () =>
          ok({ ...reply, value: { ...value, sessionId: 'session-2' } as W.SessionParameterRevision }),
      })
      expect(code(await api.sessionParameters(wrong, { runRef }, context(runScope)))).toBe(
        'internal/supervisor_peer_mismatch',
      )
      expect(
        code(
          await api.sessionParameters(
            d,
            { runRef: { ...runRef, session: { ...runRef.session, sessionId: 'session-2' } } },
            context(runScope),
          ),
        ),
      ).toBe('denied/supervisor_scope_session')
    })
  })
}
