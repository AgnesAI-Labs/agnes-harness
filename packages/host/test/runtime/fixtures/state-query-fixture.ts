/**
 * Test-only bridge. It trusts the fixture's own original context and does not prove scope
 * ancestry; a production bridge replaces it.
 */
import type { CallContext } from '@agnes/extension-api/runtime'
import { canonicalJsonDigest, type ScopeRef } from '@agnes/protocol/runtime'
import type {
  StateReadBridge,
  StateReadGrant,
  StateReadWindow,
} from '../../../src/runtime/state/read-scope.js'
import { digestOf } from '../../../src/runtime/state/records.js'
import { fixtureRef } from './assembly-maintenance-wire.js'
import type { originalNativeFixture } from './native-state-read-fixture.js'

export type NativeFixture = Awaited<ReturnType<typeof originalNativeFixture>>

export function callerWith(native: NativeFixture, scope: ScopeRef, signal?: AbortSignal): CallContext {
  return { ...native.context, scope, signal: signal ?? native.context.signal }
}

export const FIXTURE_SESSION = 'fixture-session'
export const FIXTURE_RUN = 'fixture-run-old'

export function sessionScope(native: NativeFixture): ScopeRef {
  return {
    ...native.scope,
    kind: 'session',
    workspaceId: 'fixture-workspace',
    sessionId: FIXTURE_SESSION,
  }
}
export function runScope(native: NativeFixture, runId = FIXTURE_RUN): ScopeRef {
  return {
    ...native.scope,
    kind: 'run',
    workspaceId: 'fixture-workspace',
    sessionId: FIXTURE_SESSION,
    runId,
  }
}
export function actionScope(native: NativeFixture, actionId: string, runId = FIXTURE_RUN): ScopeRef {
  return {
    ...native.scope,
    kind: 'action',
    workspaceId: 'fixture-workspace',
    sessionId: FIXTURE_SESSION,
    runId,
    actionId,
  }
}

/** Test-only bridge: trusts the fixture's own original context. */
export function localTestBridge(native: NativeFixture): StateReadBridge {
  const original = native.context
  const capture = native.identity.capture(original)
  return {
    grant(caller, requested): StateReadGrant | null {
      if (
        caller.principalRef !== original.principalRef ||
        caller.authorizationRef !== original.authorizationRef ||
        caller.signal.aborted
      )
        return null
      const scope = caller.scope
      let sessionId: string
      let window: StateReadWindow
      if (scope.kind === 'runtime') {
        if (requested === null) return null
        sessionId = requested
        window = { kind: 'session' }
      } else if (scope.kind === 'session') {
        sessionId = scope.sessionId
        window = { kind: 'session' }
      } else if (scope.kind === 'run') {
        sessionId = scope.sessionId
        window = { kind: 'run', runId: scope.runId }
      } else if (scope.kind === 'action') {
        sessionId = scope.sessionId
        window = { kind: 'action', runId: scope.runId, actionId: scope.actionId }
      } else return null
      if (requested !== null && requested !== sessionId) return null
      return Object.freeze({
        sessionId,
        window,
        fingerprint: canonicalJsonDigest({
          principalRef: caller.principalRef,
          authorizationRef: caller.authorizationRef,
          installationId: native.scope.installationId,
          runtimeId: native.scope.runtimeId,
          sessionId,
          window,
        }),
        original,
        deadline: Date.parse(original.deadline),
        check() {
          capture.dynamicCheck()
          if (caller.signal.aborted) throw new Error('caller cancelled')
        },
      })
    },
    ownedSessions(caller, page) {
      if (caller.principalRef !== original.principalRef) return null
      return page.after === null
        ? { sessionIds: [FIXTURE_SESSION], next: null }
        : { sessionIds: [], next: null }
    },
  }
}

/**
 * Commits prepared Actions to the fixture run through real State invocations (64 per transition)
 * until `count` exist in total.
 * `from` is the position the previous call returned; the result is the position after this call.
 */
export async function commitPreparedActions(
  fixture: NativeFixture,
  count: number,
  from: { committed: number; revision: number; writerEpoch: number | null } = {
    committed: 0,
    revision: 0,
    writerEpoch: null,
  },
) {
  const { authority, input } = fixture
  const { state, binding } = fixture.fixture
  const data = fixtureRef({ prompt: 'synthetic' })
  const target = {
    bindingId: binding.bindingId,
    contract: 'agh.tool',
    logicalName: 'tool',
    providerId: 'provider',
  }
  const deadline = '2027-01-01T00:00:00Z'
  const writerEpoch =
    from.writerEpoch ??
    (
      await state.open({
        requestId: 'native-read-bulk-writer',
        authority,
        sessionId: 'fixture-session',
        mode: 'write',
        writerId: 'native-read-bulk',
        ttlMs: 10_000,
      })
    ).claim?.writerEpoch
  if (writerEpoch === undefined) throw Error('write claim missing')
  let { committed, revision } = from
  for (let batch = revision; committed < count; batch++) {
    const invocationId = `native-read-invocation-${batch}`
    await state.admitInvocation({
      requestId: `native-read-admit-${batch}`,
      runId: 'fixture-run-old',
      targetActionId: null,
      baseRevision: revision,
      bindingId: binding.bindingId,
      writerEpoch: writerEpoch,
      invocationId,
      deadline,
      queryAllowance: 0,
    })
    await state.closeInvocation({
      requestId: `native-read-close-${batch}`,
      invocationId,
      state: 'prepared',
      readGuards: [],
      domainReads: [],
      unresolvedInflightIds: [],
      observedQueryCount: 0,
    })
    const actions = Array.from({ length: Math.min(64, count - committed) }, (_, index) => {
      const body = {
        key: `native-read-action-${String(committed + index).padStart(4, '0')}`,
        target,
        method: 'run',
        input: data,
        dependencies: [],
        retry: { mode: 'never' as const, maxAttempts: 0, backoffMs: [] },
        obligation: 'mandatory' as const,
        deadline,
        resultSchema: data.schema,
        references: [],
      }
      return { ...body, intentFingerprint: digestOf(body) }
    })
    await state.advanceRun({
      commitId: `native-read-advance-${batch}`,
      guard: {
        authority,
        sessionId: 'fixture-session',
        runId: 'fixture-run-old',
        writerId: 'native-read-bulk',
        writerEpoch: writerEpoch,
        expectedRunRevision: revision,
        bindingId: binding.bindingId,
        invocationId,
        readGuards: [],
        queryUsage: null,
      },
      transition: {
        expectedRevision: revision,
        continuation: {
          namespace: 'agh.test',
          codecVersion: '1',
          data,
          provenance: { sourceRefs: [], producer: target, trustLabels: [] },
          createdAt: input.fixture.now,
          references: [],
        },
        consumeSignals: [],
        actions,
        next: { kind: 'continue' },
      },
    })
    committed += actions.length
    revision++
  }
  return { committed, revision, writerEpoch }
}
