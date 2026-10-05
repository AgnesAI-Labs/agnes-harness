/**
 * Test fixtures for the State read side. The bridge adapter below is test-only and is not a
 * production bridge; it does not prove run or action ancestry.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { CallContext } from '@agnes/extension-api/runtime'
import { canonicalJsonDigest, type ScopeRef } from '@agnes/protocol/runtime'
import {
  type LocalDeploymentIdentity,
  localDeploymentIdentityBinding,
} from '../../../src/runtime/identity/local-deployment-identity.js'
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

/** The only owner name the deployment has: one local user, no user-management system. */
export const LOCAL_SESSION_OWNER = 'local'

export type BridgeBasis = Readonly<{
  /** The context the real local identity issued for this deployment. */
  context: CallContext
  identity: LocalDeploymentIdentity
  scope: ScopeRef
  /** Only used to ask the identity who the verified local principal is; never given to the reader. */
  database: DatabaseSync
}>

/**
 * TEST-ONLY bridge adapter, not a production bridge. The identity owner's real bridge replaces it.
 * The deployment has exactly one user: the verified local principal owns every session whose owner
 * is `local`. There is no per-user ACL. The mapping is still bound to the real verified principal:
 * a context is accepted only when its principal is the identity's own verified local principal, its
 * authorization is the one the identity issued, and its scope belongs to this deployment's runtime.
 * check() asks the real identity (revocation, connection generation) on every call and also
 * re-verifies the principal, the session-owner mapping and the caller's signal.
 */
export function localTestBridge(
  basis: BridgeBasis,
  sessionOwners: Map<string, string> = new Map([[FIXTURE_SESSION, LOCAL_SESSION_OWNER]]),
) {
  const original = basis.context
  const capture = basis.identity.capture(original)
  const calls = { grant: 0, check: 0 }
  const verifiedPrincipal = (): string | null => {
    try {
      return localDeploymentIdentityBinding(basis.identity, basis.database)?.owner.facts.principalRef ?? null
    } catch {
      return null
    }
  }
  const owns = (sessionId: string) => sessionOwners.get(sessionId) === LOCAL_SESSION_OWNER
  const bridge: StateReadBridge = {
    grant(caller, requested): StateReadGrant | null {
      calls.grant++
      const principal = verifiedPrincipal()
      const scope = caller.scope
      if (
        principal === null ||
        caller.principalRef !== principal ||
        caller.authorizationRef !== original.authorizationRef ||
        scope.installationId !== original.scope.installationId ||
        !('runtimeId' in scope) ||
        scope.runtimeId !== (original.scope as { runtimeId: string }).runtimeId ||
        caller.signal.aborted
      )
        return null
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
      if (!owns(sessionId)) return null
      try {
        capture.dynamicCheck()
      } catch {
        return null
      }
      return Object.freeze({
        sessionId,
        window,
        fingerprint: canonicalJsonDigest({
          principalRef: caller.principalRef,
          authorizationRef: caller.authorizationRef,
          installationId: scope.installationId,
          runtimeId: scope.runtimeId,
          sessionId,
          window,
        }),
        original,
        deadline: Math.min(Date.parse(original.deadline), Date.parse(caller.deadline)),
        check() {
          calls.check++
          capture.dynamicCheck()
          if (verifiedPrincipal() !== caller.principalRef)
            throw new Error('principal is not the verified local principal')
          if (!owns(sessionId)) throw new Error('session owner mapping is missing')
          if (caller.signal.aborted) throw new Error('caller cancelled')
        },
      })
    },
    ownedSessions(caller, page) {
      if (caller.principalRef !== verifiedPrincipal()) return null
      const all = [...sessionOwners]
        .filter(([, owner]) => owner === LOCAL_SESSION_OWNER)
        .map(([id]) => id)
        .sort()
      const rest = page.after === null ? all : all.filter((id) => id > (page.after as string))
      const sessionIds = rest.slice(0, page.limit)
      return { sessionIds, next: rest.length > sessionIds.length ? (sessionIds.at(-1) ?? null) : null }
    },
  }
  return Object.freeze({
    bridge,
    calls,
    /** Real, durable revocation of the local installation. */
    revoke: () => basis.identity.revoke(),
    /** Makes the session-owner mapping disappear, as if the session had no owner. */
    dropSessionOwner: (sessionId: string) => sessionOwners.delete(sessionId),
  })
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
