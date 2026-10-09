import { hasChildControl, transitionChildState } from '@agnes/core-child-control/child/store'
import { type OpStateObj, type ToolCallState, withPhase } from '@agnes/core-common/step/op-state'
import { CoreError, type EventInput, type Seq } from '@agnes/core-common/types'
import { approvalRefusal, isPending } from '@agnes/core-effects/effects/approval-answer'
import { type EffectHandle, type EffectOutcome, effectOutcome } from '@agnes/core-effects/effects/effect'
import type { ExecuteAttempt } from '@agnes/core-effects/effects/execute-permits'
import type { NestedToolLease } from '@agnes/core-effects/effects/scheduler'
import { buildToolContext, type FsOps, type ToolContextDeps } from '@agnes/core-effects/effects/tool-context'
import type { HostDispatchObservation } from '@agnes/core-effects/effects/tool-dispatch'
import { toLedgerContent } from '@agnes/core-effects/effects/tool-result'
import { settlesWithin, withTimeout } from '@agnes/core-effects/effects/wrap'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import type { ToolResult } from '@agnes/extension-api'
import type { Actor, ExecutionDomain, JsonValue, ResolvedToolCallPolicy } from '@agnes/protocol'
import { dispatchLoopEvent } from '../../loop/events.js'
import {
  hasAuthenticToolPolicyHash,
  hasCompleteToolPolicyEnvelope,
  hasTrustedToolCallProvenance,
  toolPolicyBindingProblem,
} from '../../registry/tool-policy.js'
import { readSessionAttachment } from '../../request/session-files.js'
import { readSessionImages } from '../../request/session-images.js'
import { imageInput, imageInputPolicy } from '../../request/tool-images.js'
import {
  approvalBindingHash,
  approvalScopesForCall,
  newPermanentGrant,
  permanentGrantId,
  permanentGrantMatches,
  persistedToolApproval,
  sessionGrantKey,
} from '../../step/approval-grants.js'
import { finishAborted } from '../../step/control.js'
import { deferredEffectId } from '../../step/deferred.js'
import type { ChainStep, SessionImpl, StepOutcome } from '../../step/session.js'
import { summarizeCall } from '../../step/summarize-call.js'
import { stepVerifyInput, toolVerifyInput } from '../../step/verify-input.js'
import { resolveModel } from './inference.js'
import { approveMemoryFile } from './memory-approval.js'
import { approvalContinuation } from './parked.js'
import { decideToolPolicy } from './policy-review.js'

export type ExecOpts = {
  depth: number
  parentEffectId?: string
  nestedLease?: NestedToolLease
  signal?: AbortSignal
  /** Propagates attachment provenance to the parent tool without changing clean nested results. */
  onAttachmentRead?: () => void
  /** A crash-recovered second dispatch of the already-durable effect. */
  resumeDispatch?: { effectId: string; startSeq: Seq; attempt: 2 }
}
export type PlannedCall = {
  toolUseId: string
  name: string
  args: unknown
  ordinal: number
  argsSeq: Seq
  resolvedPolicy: ResolvedToolCallPolicy
  executionDomain: ExecutionDomain
  definitionFingerprint: string
  policyHash: string
}
/** What one member of a batch reports back: its result, and the question it left unanswered. */
export type CallOutcome = {
  result: ToolResult
  park?: EventInput
  deferred?: { jobId: string; toolUseId: string }
}

const errorResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })
const unavailableFs = (): Promise<never> =>
  Promise.reject(
    new CoreError('E_WORKSPACE_CLOSED', 'filesystem is unavailable outside a workspace invocation'),
  )
const NO_WORKSPACE_FS: FsOps = Object.freeze({
  read: unavailableFs,
  write: unavailableFs,
  list: unavailableFs,
  stat: unavailableFs,
})
/** Conservative fixed reservation until the guardian seam publishes a countable request body. */
const GUARDIAN_RESERVATION_TOKENS = 1024

/** The harness itself, named as the canceller when a call is cut short by its own deadline. */
const timeoutActor = (a: Actor): Actor => ({
  id: 'timeout',
  org: a.org,
  role: 'system',
  deptPath: [],
  attrs: {},
})

type RuntimeToolResult = ToolResult & { deferred?: unknown }
type DeferredMarker = { present: false } | { present: true; jobId: string | null }

/**
 * The runtime marker is read structurally until extension-api publishes it on ToolResult.
 * Invalid markers remain distinguishable from an absent one, so a malformed job cannot fall back
 * to an ordinary successful tool/result and disappear from recovery.
 */
function deferredMarker(result: ToolResult): DeferredMarker {
  if (!Object.hasOwn(result, 'deferred')) return { present: false }
  const value = (result as RuntimeToolResult).deferred
  const jobId = (value as { jobId?: unknown } | null)?.jobId
  return {
    present: true,
    jobId: typeof jobId === 'string' && jobId.length > 0 && jobId.length <= 128 ? jobId : null,
  }
}

/**
 * The status patch for one call, applied to whatever the lock holder finds rather than to a base
 * read before the queue. Two members of a concurrent batch both read the phase, so a patch built on
 * a base read outside the lock silently drops the sibling's write; and once a sibling has ended the
 * turn there is no phase left to patch, which a base read outside the lock dereferences as null.
 */
type ToolCallPatch = {
  status?: ToolCallState['status']
  effectId?: string
  dispatchAttempt?: ExecuteAttempt
  dispatchPhase?: 'not_sent' | 'may_have_sent' | 'responded'
  terminate?: boolean
}

function normalizedCallState(call: ToolCallState, patch: ToolCallPatch): ToolCallState {
  const next = { ...call, ...patch } as Record<string, unknown>
  const status = next.status as ToolCallState['status']
  if (status === 'planned' || status === 'awaiting_approval' || status === 'approved') {
    delete next.effectId
    delete next.dispatchAttempt
    delete next.dispatchPhase
  } else if (status === 'effect_pending') {
    if (typeof next.effectId !== 'string')
      throw new CoreError('E_RELATION', 'effect_pending call lacks effect')
    delete next.dispatchAttempt
    delete next.dispatchPhase
  } else if (status === 'dispatch_pending') {
    if (typeof next.effectId !== 'string' || (next.dispatchAttempt !== 1 && next.dispatchAttempt !== 2))
      throw new CoreError('E_RELATION', 'dispatch_pending call lacks effect or attempt')
    if (next.dispatchPhase !== 'not_sent') delete next.dispatchPhase
  } else if (status === 'dispatched') {
    if (
      typeof next.effectId !== 'string' ||
      (next.dispatchAttempt !== 1 && next.dispatchAttempt !== 2) ||
      next.dispatchPhase !== 'may_have_sent'
    )
      throw new CoreError('E_RELATION', 'dispatched call has an invalid transport binding')
  } else if (status === 'responded') {
    if (
      typeof next.effectId !== 'string' ||
      (next.dispatchAttempt !== 1 && next.dispatchAttempt !== 2) ||
      next.dispatchPhase !== 'responded'
    )
      throw new CoreError('E_RELATION', 'responded call has an invalid transport binding')
  } else if (status === 'completed' && next.dispatchAttempt !== undefined) {
    if (
      typeof next.effectId !== 'string' ||
      (next.dispatchAttempt !== 1 && next.dispatchAttempt !== 2) ||
      !['not_sent', 'may_have_sent', 'responded'].includes(String(next.dispatchPhase))
    )
      throw new CoreError('E_RELATION', 'completed dispatch call has an invalid transport binding')
  }
  return next as ToolCallState
}

function updateCall(op: OpStateObj | null, toolUseId: string, patch: ToolCallPatch): OpStateObj | null {
  if (op?.phase.kind !== 'tools') return op
  return withPhase(op, {
    ...op.phase,
    batch: {
      ...op.phase.batch,
      calls: op.phase.batch.calls.map((c) => (c.toolUseId === toolUseId ? normalizedCallState(c, patch) : c)),
    },
  })
}

function dispatchErrorResult(code: string, message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true, details: { code } }
}

/**
 * Model-facing text for a mutation call whose outcome stays unknown. A deadline or a cancel is ours
 * and is named as such, so it is not mistaken for a lost transport and retried blindly.
 */
function unknownOutcomeMessage(name: string, cause: 'timeout' | 'cancelled' | undefined, ms: number): string {
  if (!cause) return `the outcome of ${name} is unknown after dispatch`
  const why =
    cause === 'timeout'
      ? `exceeded the ${ms} ms limit for one call and was aborted`
      : 'was cancelled while running'
  return (
    `the outcome of ${name} is unknown: it ${why}, so it may have taken partial effect. ` +
    'Inspect the current state before retrying; do not rerun it unchanged.' +
    (cause === 'timeout'
      ? ' Split it into shorter steps, or run it in the background if the tool offers that.'
      : '')
  )
}

/**
 * How long a call that was cancelled has to come to rest before the ledger is written. A killed
 * process group answers well inside it; a tool still running when it ends is not known to have stopped.
 */
const STOPPED_CALL_REST_MS = 1500

/**
 * Model-facing text for a mutation call a cancel stopped and that then came to rest. It says
 * "cancelled", not "unknown", but keeps the warning: what it did before it stopped is not known.
 * It does not say who cancelled: a shutdown writes the same row as a user's Stop.
 */
function userStoppedMessage(name: string): string {
  return (
    `${name} was cancelled while running and has stopped, so it may have taken partial effect. ` +
    'Inspect the current state before retrying; do not rerun it unchanged.'
  )
}

/**
 * Who asked for the stop, if the ledger says anyone did. Read afresh: the request is recorded after
 * the call began, so an op read earlier cannot hold it.
 */
function stopRequestedBy(s: SessionImpl): Actor | undefined {
  const control = s.op()?.control
  return control?.status === 'cancel_requested' ? control.by : undefined
}

async function settleSyntheticDispatch(
  s: SessionImpl,
  call: PlannedCall,
  effect: Pick<EffectHandle, 'effectId' | 'settle'>,
  attempt: ExecuteAttempt,
  phase: 'not_sent' | 'may_have_sent',
  decisionId: string,
  input: {
    code: 'CANCELLED' | 'TOOL_DISPATCH_FAILED' | 'TOOL_DISPATCH_NOT_SENT' | 'TOOL_OUTCOME_UNKNOWN'
    message: string
    outcome: EffectOutcome
    cancelledBy?: Actor
    partial?: boolean
  },
): Promise<ToolResult> {
  const result = dispatchErrorResult(input.code, input.message)
  await s.transition(
    [
      s.ev(
        'tool/result',
        {
          toolUseId: call.toolUseId,
          content: toLedgerContent(result.content),
          isError: true,
          code: input.code,
          ...(input.code === 'CANCELLED'
            ? { partial: input.partial ?? false, cancelledBy: input.cancelledBy ?? s.d.actor }
            : {}),
          enforcement: s.d.runtime.enforcement(),
          authz: { decisionId },
        },
        { sourceEventSeqs: [call.argsSeq] },
      ),
      effect.settle(input.outcome),
    ],
    (cur) =>
      updateCall(cur, call.toolUseId, {
        status: 'completed',
        effectId: effect.effectId,
        dispatchAttempt: attempt,
        dispatchPhase: phase,
      }),
  )
  return result
}

/**
 * A refusal that never became an effect. It writes the result and nothing else: there was no intent
 * and there is no settlement, because nothing happened outside the process. The approval record, if
 * one was asked for, is already on the ledger beside it.
 */
export async function refuse(
  s: SessionImpl,
  toolUseId: string,
  code: string,
  message: string,
  decisionId = 'n/a',
): Promise<ToolResult> {
  const result = dispatchErrorResult(code, message)
  const callSeq = s.state.toolCalls.get(toolUseId)?.seq
  await s.transition(
    [
      s.ev(
        'tool/result',
        {
          toolUseId,
          content: result.content,
          isError: true,
          code,
          enforcement: s.d.runtime.enforcement(),
          authz: { decisionId },
        },
        callSeq === undefined ? {} : { sourceEventSeqs: [callSeq] },
      ),
    ],
    (cur) => updateCall(cur, toolUseId, { status: 'completed' }),
  )
  return result
}

export async function approveAndExecute(
  s: SessionImpl,
  call: PlannedCall,
  o: ExecOpts,
): Promise<CallOutcome> {
  const op = s.op() as OpStateObj
  const t = s.turn
  if (!t) return { result: errorResult('no open turn') }
  // A recovered attempt may already have reached the OS and must finish its exactly-once
  // settlement. New/planned calls are still refused before hooks, approval, or effect intent.
  if (!o.resumeDispatch && call.name === 'computer_use' && !s.computerUseAllowed())
    return {
      result: await refuse(
        s,
        call.toolUseId,
        'TOOL_NOT_DISCLOSED',
        'tool is unavailable to the current primary model',
      ),
    }
  const def = t.snapshot.byName.get(call.name)
  if (!def) return { result: await refuse(s, call.toolUseId, 'TOOL_NOT_FOUND', `unknown tool ${call.name}`) }
  if (!hasAuthenticToolPolicyHash(call))
    return {
      result: errorResult('parked: persisted tool policy hash does not match its policy'),
      park: s.ev(
        'x/core/tool-policy-hash-mismatch',
        { toolUseId: call.toolUseId, name: call.name, persistedPolicyHash: call.policyHash },
        { ignorable: true, sourceEventSeqs: [call.argsSeq] },
      ),
    }
  if (def.definitionFingerprint !== call.definitionFingerprint)
    return {
      result: errorResult('parked: tool definition changed after policy resolution'),
      park: s.ev(
        'x/core/tool-definition-drift',
        {
          toolUseId: call.toolUseId,
          name: call.name,
          persistedFingerprint: call.definitionFingerprint,
          currentFingerprint: def.definitionFingerprint,
        },
        { ignorable: true, sourceEventSeqs: [call.argsSeq] },
      ),
    }
  const meta = def.meta
  const policy = call.resolvedPolicy
  const recoveredEffect = o.resumeDispatch ? s.state.pendingEffects.get(o.resumeDispatch.effectId) : undefined
  if (
    o.resumeDispatch &&
    (!recoveredEffect ||
      recoveredEffect.intentSeq !== o.resumeDispatch.startSeq ||
      recoveredEffect.kind !== 'tool' ||
      recoveredEffect.tool?.toolUseId !== call.toolUseId ||
      recoveredEffect.tool.name !== call.name ||
      recoveredEffect.replay !== policy.replay)
  )
    throw new CoreError('E_RELATION', 'recovered dispatch does not match its pending effect')
  let decisionId = 'n/a'
  if (!o.resumeDispatch) {
    // Read from the fold, not from the counter: the counter's copy is a transaction behind the row
    // that taints, so the first call after an untrusted result would be judged against a clean turn.
    const taint = op.taint || s.laneTaint()
    const gate = await dispatchLoopEvent(
      s,
      'before_tool_call',
      {
        toolUseId: call.toolUseId,
        name: call.name,
        args: call.args as JsonValue,
        meta,
        actor: s.d.actor,
        taint,
        resolvedPolicy: policy,
        executionDomain: call.executionDomain,
        definitionFingerprint: call.definitionFingerprint,
        policyHash: call.policyHash,
      },
      o.signal ?? s.ac.signal,
    )
    // A hook denial is not an approval question: nobody is asked, because the answer is already no.
    if (!gate.allow) return { result: await refuse(s, call.toolUseId, 'HOOK_DENIED', gate.reason) }
    const risk = policy.requiresApproval
    const stepId = `${op.meta.turn}/${op.step}`
    const decision = await s.d.runtime.authorize(s.d.actor, 'execute', { kind: 'skill', id: call.name })
    decisionId = decision.decisionId
    if (decision.effect === 'deny')
      return { result: await refuse(s, call.toolUseId, 'AUTHZ_DENIED', decision.reason, decisionId) }
    if ((o.signal ?? s.ac.signal).aborted) {
      await s.transition([], (cur) => updateCall(cur, call.toolUseId, { status: 'approved' }))
      return {
        result: await refuse(s, call.toolUseId, 'CANCELLED', 'cancelled before dispatch', decisionId),
      }
    }
    if (call.executionDomain === 'workspace' && !policy.isReadOnly && !s.d.runtime.sandboxAllowed())
      return {
        result: await refuse(
          s,
          call.toolUseId,
          'SANDBOX_UNAVAILABLE',
          'Sandbox enforcement unavailable',
          decisionId,
        ),
      }
    for (const path of meta.paths ?? []) {
      const args = call.args as Record<string, unknown>
      const target = Object.hasOwn(args, path.arg) ? args[path.arg] : path.default
      if (target === undefined) continue
      if (typeof target !== 'string' || !target || target.includes('\0'))
        return {
          result: await refuse(
            s,
            call.toolUseId,
            'E_FS_DENIED',
            'Invalid declared workspace path',
            decisionId,
          ),
        }
      const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(target)?.[1]?.toLowerCase()
      if (scheme && path.nonWorkspaceSchemes?.includes(scheme)) continue
      try {
        if (!s.d.workspaceInvocation) throw new Error('Workspace path preflight unavailable')
        await s.d.workspaceInvocation.run(async (view) => {
          const fs = view.fs()
          if (fs.preflight) await fs.preflight(target, path.access)
          else if (path.access === 'read') await fs.stat(target)
          else throw new Error('Workspace write preflight unavailable')
        })
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT')
          return {
            result: await refuse(
              s,
              call.toolUseId,
              'E_FS_DENIED',
              'Filesystem policy refuses this path',
              decisionId,
            ),
          }
      }
    }
    if (!(await s.d.runtime.approvalToolAllowed(call.name, call.args)))
      return {
        result: await refuse(
          s,
          call.toolUseId,
          'POLICY_DENIED',
          'Command deny-list refuses the call',
          decisionId,
        ),
      }
    const approvalMode = s.d.approvalMode ?? 'manual'
    const permission = await decideToolPolicy(
      s,
      structuredClone({
        sessionKey: s.key,
        cwd: s.d.cwd,
        actor: s.d.actor,
        call: {
          id: call.toolUseId,
          name: call.name,
          args: call.args as JsonValue,
          description: def.description,
          parameters: def.parameters as JsonValue,
          definitionFingerprint: call.definitionFingerprint,
        },
        policy,
        category: meta.isOpenWorld ? 'external' : policy.isReadOnly ? 'read' : 'write',
        tainted: taint,
        fullAccess: s.yolo,
        approvalMode,
      }),
      o.signal ?? s.ac.signal,
    )
    if (
      !permission ||
      !['allow', 'ask', 'deny'].includes(permission.effect) ||
      typeof permission.reason !== 'string'
    )
      throw new CoreError('E_ENVELOPE', 'invalid ToolPolicy decision')
    if (permission.effect === 'deny')
      return { result: await refuse(s, call.toolUseId, 'POLICY_DENIED', permission.reason, decisionId) }
    const needsAsk =
      permission.effect === 'ask' ||
      (decision.effect === 'require_approval' && !s.yolo && approvalMode !== 'off')
    const scopes = approvalScopesForCall(call.name, policy.approvalScopes)
    const guardianFailed = (
      await scanAll((q) => s.d.log.scan(q), {
        fromSeq: call.argsSeq,
        toSeq: s.lastSeq,
        type: 'x/core/approval-guardian-failed',
        lane: s.lane,
      })
    ).some((row) => {
      const failedTool = (row.data as { toolUseId?: unknown } | null)?.toolUseId
      return failedTool === undefined || failedTool === call.toolUseId
    })
    for (const scope of needsAsk ? scopes : []) {
      const bindingHash = approvalBindingHash({
        sessionKey: s.key,
        stepId,
        toolUseId: call.toolUseId,
        args: call.args,
        policyHash: call.policyHash,
        scope,
      })
      const grantKey = sessionGrantKey({ actor: s.d.actor, sessionKey: s.key, toolId: call.name, scope })
      const profileHash = s.d.resolvedProfileHash
      const durableBinding =
        profileHash !== null && /^sha256-[a-f0-9]{64}$/.test(profileHash)
          ? {
              actor: s.d.actor,
              profileHash,
              toolId: call.name,
              scope,
              policyVersion: policy.policyVersion,
            }
          : undefined
      const durableGrants = durableBinding
        ? (
            await s.d.runtime.approvalGrants(
              {
                profileHash: durableBinding.profileHash,
                actorId: durableBinding.actor.id,
                actorOrg: durableBinding.actor.org,
                toolId: durableBinding.toolId,
                scope: durableBinding.scope,
                policyVersion: durableBinding.policyVersion,
              },
              o.signal ?? s.ac.signal,
            )
          ).filter((grant) => permanentGrantMatches(grant, durableBinding))
        : []
      const recorded = await persistedToolApproval(s, {
        toolUseId: call.toolUseId,
        args: call.args,
        scope,
        policyHash: call.policyHash,
        policyVersion: policy.policyVersion,
      })
      if (recorded?.verdict === 'allowed-session') s.sessionAllows.add(grantKey)
      if (recorded?.verdict === 'allowed-permanent') {
        if (!durableBinding || !recorded.grantId)
          return {
            result: await refuse(
              s,
              call.toolUseId,
              'APPROVAL_GRANT_UNAVAILABLE',
              'permanent approval requires a resolved profile hash',
              decisionId,
            ),
          }
        const alreadyStored = durableGrants.some((grant) => grant.grantId === recorded.grantId)
        const stored =
          alreadyStored ||
          (await s.d.runtime.approvalPutGrant(
            newPermanentGrant({
              ...durableBinding,
              grantId: recorded.grantId,
              createdAt: recorded.decidedAt,
            }),
            o.signal ?? s.ac.signal,
          ))
        if (!stored) {
          await s.transition(
            [
              s.ev(
                'x/core/approval-grant-activation-failed',
                {
                  requestId: recorded.requestId,
                  grantId: recorded.grantId,
                  toolUseId: call.toolUseId,
                  scope,
                  reason: 'durable grant store unavailable',
                },
                { ignorable: true, sourceEventSeqs: [call.argsSeq] },
              ),
            ],
            s.op() as OpStateObj,
          )
          return {
            result: await refuse(
              s,
              call.toolUseId,
              'APPROVAL_GRANT_UNAVAILABLE',
              'permanent approval could not be stored',
              decisionId,
            ),
          }
        }
        const activated = (
          await scanAll((q) => s.d.log.scan(q), {
            fromSeq: call.argsSeq,
            toSeq: s.lastSeq,
            type: 'x/core/approval-grant-activated',
            lane: s.lane,
          })
        ).some((row) => {
          const data = row.data as { requestId?: unknown; grantId?: unknown } | null
          return data?.requestId === recorded.requestId && data.grantId === recorded.grantId
        })
        if (!activated)
          await s.transition(
            [
              s.ev(
                'x/core/approval-grant-activated',
                {
                  requestId: recorded.requestId,
                  grantId: recorded.grantId,
                  toolUseId: call.toolUseId,
                  scope,
                  recovered: alreadyStored,
                },
                { ignorable: true, sourceEventSeqs: [call.argsSeq] },
              ),
            ],
            s.op() as OpStateObj,
          )
        continue
      }
      if (recorded?.verdict === 'allowed-once' || recorded?.verdict === 'allowed-session') continue
      if (recorded) {
        return {
          result: await refuse(
            s,
            call.toolUseId,
            'APPROVAL_REJECTED',
            `approval ${recorded.verdict}`,
            decisionId,
          ),
        }
      }
      if (s.sessionAllows.has(grantKey) || durableGrants.length > 0) continue
      const priorGuardian = (
        await scanAll((q) => s.d.log.scan(q), {
          fromSeq: call.argsSeq,
          toSeq: s.lastSeq,
          type: 'approval/guardian-decided',
          lane: s.lane,
        })
      ).find((row) => {
        const data = row.data as {
          toolUseId?: unknown
          scope?: unknown
          bindingHash?: unknown
          policyHash?: unknown
        } | null
        return (
          row.origin === 'system' &&
          row.trust === 'trusted' &&
          row.actor.id === s.d.actor.id &&
          row.actor.org === s.d.actor.org &&
          data?.toolUseId === call.toolUseId &&
          data.scope === scope &&
          data.bindingHash === bindingHash &&
          data.policyHash === call.policyHash
        )
      })
      const priorGuardianData = priorGuardian?.data as
        | { requestId: string; decision: 'allow-once' | 'allow-session' | 'escalate' | 'reject' }
        | undefined
      // An allow/reject guardian row is committed atomically with its asked/decided rows. Seeing
      // one without the matching persisted decision means the ledger is not a state we can safely
      // reconstruct; never re-run the guardian or silently dispatch from it.
      if (
        priorGuardianData &&
        (priorGuardianData.decision === 'allow-once' ||
          priorGuardianData.decision === 'allow-session' ||
          priorGuardianData.decision === 'reject')
      )
        return {
          result: await refuse(
            s,
            call.toolUseId,
            'APPROVAL_STATE_INVALID',
            'guardian decision is missing its bound approval decision',
            decisionId,
          ),
        }
      const requestId = priorGuardianData?.requestId ?? s.d.ids.requestId()
      const options = [
        'allowed-once' as const,
        'allowed-session' as const,
        ...(durableBinding ? (['allowed-permanent'] as const) : []),
        'rejected' as const,
      ]
      const asked = {
        requestId,
        kind: 'tool' as const,
        toolUseId: call.toolUseId,
        summary: permission.review
          ? `${summarizeCall(call.name, call.args)} — ${permission.reason}`
          : summarizeCall(call.name, call.args),
        risk: risk === 'always' ? ('always' as const) : ('destructive' as const),
        bindingHash,
        scope,
        policyVersion: policy.policyVersion,
        ...(durableBinding ? { profileHash: durableBinding.profileHash } : {}),
        options,
        deadline: new Date(s.d.clock() + s.preset.approval.timeoutMs).toISOString(),
      }
      // A transform hook: an extension may adjust risk/context/summary before the question reaches a
      // human, the same waterfall shape `context`/`before_request` already use. `argv` is cast rather
      // than re-validated here because the inference or nested-call entry validated `call.args`
      // before persisting the exact args and resolved policy binding consumed by this dispatch.
      const overridden = s.hooks.approvalRequest
        ? (
            await s.hooks.approvalRequest({
              request: {
                tool: call.name,
                argv: call.args as JsonValue,
                risk: asked.risk,
                actor: s.d.actor,
                summary: asked.summary,
              },
            })
          ).request
        : undefined
      const finalAsked = overridden
        ? {
            ...asked,
            risk: overridden.risk ?? asked.risk,
            ...(overridden.summary !== undefined ? { summary: overridden.summary } : {}),
          }
        : asked
      const approvalRequest = {
        ...finalAsked,
        sessionKey: s.key,
        stepId,
        tool: { name: call.name, args: call.args, meta },
        actor: s.d.actor,
        taint,
        scope,
        profileHash: s.d.resolvedProfileHash,
        policyVersion: policy.policyVersion,
        options: [...options],
        ...(overridden?.context !== undefined ? { context: overridden.context } : {}),
      }
      if (approvalMode === 'smart' && !permission.review && !guardianFailed && !priorGuardianData) {
        const guardianModel = resolveModel(s, 'primary').model
        const projected = await s.d.runtime.ledgerProjected({
          tokensEstimate: GUARDIAN_RESERVATION_TOKENS,
          model: guardianModel,
        })
        const cap = s.turnBudgetCap()
        const budgetApproved =
          Number.isFinite(projected.credits) && (cap === null || projected.credits <= cap)
        const guardian = s.effects.start({
          kind: 'approval-guardian',
          tool: { toolUseId: call.toolUseId, name: call.name },
          replay: 'never',
          argsSeq: call.argsSeq,
        })
        await s.transition([guardian.intent], s.op() as OpStateObj)
        let guarded = budgetApproved
          ? await s.d.runtime.approvalGuard(approvalRequest, o.signal ?? s.ac.signal)
          : {
              decision: 'escalate' as const,
              ruleVersion: 'budget-v1',
              reasons: ['guardian reservation exceeds the active budget'],
            }
        const costEvents: EventInput[] = []
        if (budgetApproved && guarded.ruleVersion !== 'missing') {
          const spend = {
            purpose: 'approval-guardian' as const,
            effectId: guardian.effectId,
            tokens: {
              input: GUARDIAN_RESERVATION_TOKENS,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
            credits: projected.credits,
            creditSource: projected.creditSource,
            model: guardianModel,
          }
          const recorded = await s.d.runtime.ledgerRecord({
            ...spend,
            sessionKey: s.key,
            lane: s.lane,
            turn: op.meta.turn,
            step: op.step,
          })
          costEvents.push(s.ev('cost/ledger', spend))
          if (!recorded) {
            if (s.turn) s.turn.ledgerFailed = true
            guarded = {
              decision: 'escalate',
              ruleVersion: 'failed',
              reasons: ['guardian cost ledger unavailable'],
            }
          }
        }
        const guardianVerdict =
          guarded.decision === 'allow-session'
            ? ('allowed-session' as const)
            : guarded.decision === 'allow-once'
              ? ('allowed-once' as const)
              : guarded.decision === 'reject'
                ? ('rejected' as const)
                : undefined
        await s.transition(
          [
            s.ev('approval/guardian-decided', {
              requestId,
              effectId: guardian.effectId,
              toolUseId: call.toolUseId,
              scope,
              bindingHash,
              policyHash: call.policyHash,
              decision: guarded.decision,
              ruleVersion: guarded.ruleVersion,
              reasons: guarded.reasons,
              ...(guarded.model ? { model: guarded.model } : {}),
              budget: {
                tokensReserved: GUARDIAN_RESERVATION_TOKENS,
                credits: Number.isFinite(projected.credits) ? projected.credits : Number.MAX_VALUE,
                creditSource: projected.creditSource,
                cap,
                approved: budgetApproved,
              },
            }),
            guardian.settle(
              guarded.ruleVersion === 'failed' || guarded.ruleVersion === 'missing' || !budgetApproved
                ? 'error'
                : 'ok',
            ),
            ...costEvents,
            ...(guardianVerdict
              ? [
                  s.ev('approval/asked', finalAsked),
                  s.ev('approval/decided', {
                    requestId,
                    verdict: guardianVerdict,
                    via: 'guardian',
                    scope,
                  }),
                ]
              : []),
          ],
          (cur) =>
            updateCall(cur, call.toolUseId, {
              // Keep the call recoverable until either refusal writes its result or execution
              // crosses its own effect intent. A crash after the decision reconsumes the ledger.
              status: 'planned',
            }),
        )
        if (guardianVerdict === 'allowed-once' || guardianVerdict === 'allowed-session') {
          if (guardianVerdict === 'allowed-session') s.sessionAllows.add(grantKey)
          continue
        }
        if (guardianVerdict === 'rejected')
          return {
            result: await refuse(
              s,
              call.toolUseId,
              'APPROVAL_REJECTED',
              'smart guardian rejected the call',
              decisionId,
            ),
          }
      }
      const storage = s.d.log.storage
      if (hasChildControl(storage)) await transitionChildState(storage, s.key, 'waiting_approval')
      const answer = await s.askApprovalAnswer(approvalRequest, o.signal ?? s.ac.signal)
      if (hasChildControl(storage) && !isPending(answer))
        await transitionChildState(storage, s.key, 'running')
      if (isPending(answer)) {
        // The ask is handed back rather than written here. Parking closes the turn, and a member of a
        // concurrent batch that closes the turn under its siblings leaves the next one writing a
        // `step/end` into a turn that is already over. One writer ends the batch, and it carries
        // every unanswered question with it rather than dropping the ones that lost the race.
        return {
          result: errorResult('parked'),
          park: s.ev('approval/asked', { ...finalAsked, pending: answer }),
        }
      }
      // A delegated sub-agent has no one to ask: unanswered is refused, and says why.
      const refused =
        answer.verdict === 'unavailable' && hasChildControl(storage) && !!(await storage.lookupByKey(s.key))
      const verdict = refused ? 'rejected' : answer.verdict
      const reason = refused ? 'subagent_scope' : answer.reason
      const grantId =
        verdict === 'allowed-permanent'
          ? permanentGrantId({ sessionKey: s.key, toolUseId: call.toolUseId, scope })
          : undefined
      await s.transition(
        [
          s.ev('approval/asked', finalAsked),
          s.ev('approval/decided', {
            requestId,
            verdict,
            via: 'sync',
            scope,
            ...(reason ? { reason } : {}),
            ...(grantId ? { grantId } : {}),
          }),
        ],
        (cur) => updateCall(cur, call.toolUseId, { status: 'planned' }),
      )
      if (verdict === 'allowed-permanent') {
        const persisted = await persistedToolApproval(s, {
          toolUseId: call.toolUseId,
          args: call.args,
          scope,
          policyHash: call.policyHash,
          policyVersion: policy.policyVersion,
        })
        if (!grantId || !durableBinding || !persisted || persisted.grantId !== grantId)
          return {
            result: await refuse(
              s,
              call.toolUseId,
              'APPROVAL_STATE_INVALID',
              'permanent approval ledger binding is missing',
              decisionId,
            ),
          }
        const stored = await s.d.runtime.approvalPutGrant(
          newPermanentGrant({
            ...durableBinding,
            grantId,
            createdAt: persisted.decidedAt,
          }),
          o.signal ?? s.ac.signal,
        )
        if (!stored) {
          await s.transition(
            [
              s.ev(
                'x/core/approval-grant-activation-failed',
                {
                  requestId,
                  grantId,
                  toolUseId: call.toolUseId,
                  scope,
                  reason: 'durable grant store unavailable',
                },
                { ignorable: true, sourceEventSeqs: [call.argsSeq] },
              ),
            ],
            s.op() as OpStateObj,
          )
          return {
            result: await refuse(
              s,
              call.toolUseId,
              'APPROVAL_GRANT_UNAVAILABLE',
              'permanent approval could not be stored',
              decisionId,
            ),
          }
        }
        await s.transition(
          [
            s.ev(
              'x/core/approval-grant-activated',
              { requestId, grantId, toolUseId: call.toolUseId, scope, recovered: false },
              { ignorable: true, sourceEventSeqs: [call.argsSeq] },
            ),
          ],
          s.op() as OpStateObj,
        )
        continue
      }
      if (verdict === 'allowed-session') s.sessionAllows.add(grantKey)
      if (!verdict.startsWith('allowed')) {
        const refusal = approvalRefusal(verdict, reason, s.preset.approval.timeoutMs)
        return { result: await refuse(s, call.toolUseId, refusal.code, refusal.text, decisionId) }
      }
    }
  }
  if (call.executionDomain === 'workspace' && !policy.isReadOnly && !s.d.runtime.sandboxAllowed())
    return {
      result: await refuse(
        s,
        call.toolUseId,
        'SANDBOX_UNAVAILABLE',
        'sandbox enforcement is none and the preset denies',
        decisionId,
      ),
    }
  try {
    s.assertToolDispatchAvailable(call.executionDomain)
  } catch {
    if (o.resumeDispatch) {
      if (!recoveredEffect) throw new CoreError('E_RELATION', 'recovered dispatch lacks its pending effect')
      const result = await settleSyntheticDispatch(
        s,
        call,
        {
          effectId: recoveredEffect.effectId,
          settle: (outcome) =>
            s.ev('effect/settled', { effectId: recoveredEffect.effectId, outcome, durationMs: 0 }),
        },
        2,
        'not_sent',
        decisionId,
        {
          code: 'TOOL_DISPATCH_NOT_SENT',
          message: 'host-computer-use dispatch is unavailable during recovered attempt',
          outcome: 'error',
        },
      )
      return { result }
    }
    return {
      result: await refuse(
        s,
        call.toolUseId,
        'HOST_DISPATCH_UNAVAILABLE',
        'host-computer-use dispatch is unavailable',
        decisionId,
      ),
    }
  }
  const parent = o.signal ?? s.ac.signal
  let effect: Pick<EffectHandle, 'effectId' | 'settle'>
  let startSeq: Seq
  let initialAttempt: ExecuteAttempt
  // Set only on a first dispatch, whose commit above already recorded the workspace `dispatched`. A
  // recovered dispatch has no such commit and records it in the loop before invoking.
  let firstDispatchCommitted = false
  if (o.resumeDispatch) {
    if (!recoveredEffect) throw new CoreError('E_RELATION', 'recovered dispatch lacks its pending effect')
    effect = {
      effectId: recoveredEffect.effectId,
      settle: (outcome) =>
        s.ev('effect/settled', { effectId: recoveredEffect.effectId, outcome, durationMs: 0 }),
    }
    startSeq = recoveredEffect.intentSeq
    initialAttempt = o.resumeDispatch.attempt
    s.restoreToolDispatchAttempt(effect.effectId, startSeq, 1)
  } else {
    if (parent.aborted) {
      await s.transition([], (cur) => updateCall(cur, call.toolUseId, { status: 'approved' }))
      return {
        result: await refuse(s, call.toolUseId, 'CANCELLED', 'cancelled before dispatch', decisionId),
      }
    }
    const started = s.effects.start({
      ...(o.parentEffectId ? { parentEffectId: o.parentEffectId } : {}),
      kind: 'tool',
      tool: { toolUseId: call.toolUseId, name: call.name },
      replay: policy.replay,
      argsSeq: call.argsSeq,
    })
    effect = started
    // Approved, intent written, and (for a workspace call) dispatched, as one commit. Only
    // synchronous code runs between these edges — the loop below re-checks the abort signal before
    // it invokes anything — so no crash can land between them, and a reopened session sees either
    // the call still planned or the call dispatched with its intent. The intermediate statuses are
    // implied by the intent row and are never stored on their own. A Host call records `dispatched`
    // only once its port has returned, so it stops at dispatch_pending here.
    const chain: ChainStep[] = [
      { events: [], next: (cur) => updateCall(cur, call.toolUseId, { status: 'approved' }) },
      {
        events: [started.intent],
        next: (cur) =>
          updateCall(cur, call.toolUseId, {
            status: 'dispatch_pending',
            effectId: started.effectId,
            dispatchAttempt: 1,
          }),
      },
    ]
    if (call.executionDomain === 'workspace')
      chain.push({
        events: [],
        next: (cur) =>
          updateCall(cur, call.toolUseId, {
            status: 'dispatched',
            effectId: started.effectId,
            dispatchAttempt: 1,
            dispatchPhase: 'may_have_sent',
          }),
      })
    // The intent's own seq: the only one a dispatch permit may be bound to.
    const [, startedSeqs] = await s.transitionChain(chain)
    const committed = startedSeqs?.[0]
    if (committed === undefined)
      throw new CoreError('E_RELATION', 'effect intent commit returned no sequence')
    startSeq = committed
    initialAttempt = 1
    firstDispatchCommitted = call.executionDomain === 'workspace'
  }
  const timeoutMs = s.preset.tools.timeouts[call.name] ?? s.preset.tools.timeoutMs
  // The tool is told a limit a grace short of the one enforced below, so a tool that honours it can
  // return its own result (partial output, the cause) before the kernel cuts the call off.
  const softTimeoutMs = timeoutMs - Math.min(2000, Math.floor(timeoutMs / 10))
  const ac = new AbortController()
  const nestedParks: EventInput[] = []
  const onAbort = () => ac.abort()
  if (parent.aborted) ac.abort()
  else parent.addEventListener('abort', onAbort, { once: true })
  try {
    let attachmentRead = false
    const markAttachmentRead = () => {
      attachmentRead = true
      o.onAttachmentRead?.()
    }
    const invokeNested = (name: string, args: unknown, io: { signal?: AbortSignal; depth: number }) => {
      return s.invokeTool(name, args, {
        ...io,
        parentEffectId: effect.effectId,
        ...(o.nestedLease ? { nestedLease: o.nestedLease } : {}),
        onPark: (event) => nestedParks.push(event),
        onAttachmentRead: markAttachmentRead,
      })
    }
    const computerUseAllowed = s.computerUseAllowed()
    const context = (fsOps: FsOps, workspace?: ToolContextDeps['workspace']) =>
      buildToolContext(
        {
          sessionKey: s.key,
          lane: s.lane,
          turn: op.meta.turn,
          step: op.step,
          depth: o.depth,
          generationDepth: s.generationDepth,
          actor: s.d.actor,
          cwd: s.d.cwd,
          fullAccess: s.yolo,
          runtime: s.d.runtime,
          preset: s.preset,
          children: s.d.children,
          fsOps,
          ...(s.d.memory && workspace
            ? {
                memory: {
                  session: s.d.memory,
                  approve: (proposal: import('@agnes/extension-api').MemoryProposal) =>
                    approveMemoryFile(s, proposal, { name: call.name, meta: def.meta }, op.step, ac.signal),
                },
              }
            : {}),
          ...(workspace ? { workspace } : {}),
          netFetch: s.d.netFetch,
          ...(s.d.publicFetch ? { publicFetch: s.d.publicFetch } : {}),
          log: s.d.logger,
          invoke: invokeNested,
          listTools: () =>
            t.snapshot.defs.filter((definition) => definition.name !== 'computer_use' || computerUseAllowed),
          appendPlan: (items) =>
            s.d.log
              .append([s.ev('plan.items', { items }, { register: 'plan.items' })])
              .then((r) => r.firstSeq),
          requestCompaction: (i) => {
            t.compactionRequested = i ?? null
          },
          ...(s.d.requestMedia ? { readImages: (input) => readSessionImages(s, input, ac.signal) } : {}),
          imageInputPolicy: async () => imageInputPolicy(s),
          imageInput: (input) => imageInput(s, input, ac.signal),
          readAttachment: (input) => {
            markAttachmentRead()
            return readSessionAttachment(s, input, ac.signal)
          },
          progress: () => undefined,
          artifactJobEvent: (job) =>
            s.d.log
              .append([
                s.ev('artifact/job', job, { register: 'artifact/job', sourceEventSeqs: [call.argsSeq] }),
              ])
              .then(() => undefined),
          // What the writer lease actually has left, not a constant: a tool budgeting its own work
          // against a number the kernel invented plans against a deadline that is not the real one.
          lease: { remainingMs: () => s.d.log.leaseRemainingMs() },
        },
        {
          toolUseId: call.toolUseId,
          name: call.name,
          signal: ac.signal,
          timeoutMs: softTimeoutMs,
          defaultTimeoutMs: s.preset.tools.timeoutMs,
          outputMaxBytes: s.preset.tools.outputMaxBytes,
        },
      )
    const invoke = (ctx: ReturnType<typeof context>, attempt: ExecuteAttempt) =>
      s.executeTool(
        call.name,
        call.args,
        ctx,
        { effectId: effect.effectId, startSeq },
        () => def.execute(call.args as never, ctx),
        { executionDomain: call.executionDomain, attempt },
      )
    const invokeAttempt = (attempt: ExecuteAttempt): Promise<HostDispatchObservation> => {
      const workspaceInvocation = s.d.workspaceInvocation
      if (workspaceInvocation) {
        const handler = async (
          view: import('@agnes/core-effects/workspace/runtime').WorkspaceInvocationView,
        ) => {
          const confined = await view.ready(ac.signal)
          const ctx = context(view.fs(), {
            sandbox: view.hookSandbox(),
            confine: (argv) => confined.confine(argv),
            checkpoint: view.checkpointContext(),
          })
          return invoke(ctx, attempt)
        }
        return s.d.workspacePublication
          ? s.d.workspacePublication.workspace(() => ({ port: workspaceInvocation, handler }))
          : workspaceInvocation.run(handler)
      }
      if (call.executionDomain === 'workspace')
        return Promise.reject(
          new CoreError('E_WORKSPACE_CLOSED', 'workspace tool execution needs an invocation port'),
        )
      return invoke(context(NO_WORKSPACE_FS), attempt)
    }
    let attempt: ExecuteAttempt = initialAttempt
    let observation: HostDispatchObservation
    let timedOut = false
    let cancelled = false
    // The call itself, which `withTimeout` stops waiting for the moment a cancel lands.
    let dispatched: Promise<HostDispatchObservation> | undefined
    while (true) {
      if (ac.signal.aborted) {
        return {
          result: await settleSyntheticDispatch(s, call, effect, attempt, 'not_sent', decisionId, {
            code: 'CANCELLED',
            message: 'cancelled before dispatch',
            outcome: 'aborted',
            cancelledBy: s.d.actor,
          }),
        }
      }
      if (firstDispatchCommitted) firstDispatchCommitted = false
      else if (call.executionDomain === 'workspace')
        await s.transition([], (cur) =>
          updateCall(cur, call.toolUseId, {
            status: 'dispatched',
            effectId: effect.effectId,
            dispatchAttempt: attempt,
            dispatchPhase: 'may_have_sent',
          }),
        )
      try {
        // Deliberately not the injected timers: those drive the writer lease, and a test that freezes
        // them to hold a lease still has to be able to watch a tool run out of time.
        dispatched = invokeAttempt(attempt)
        observation = await withTimeout(dispatched, timeoutMs, call.name, ac.signal)
      } catch (error) {
        timedOut = error instanceof Error && error.message.startsWith('timeout:')
        cancelled = !timedOut && ac.signal.aborted
        observation = { phase: 'may_have_sent', error }
        // A cooperative stop can return a truthful receipt after the abort wins the race.
        // Retain that receipt; do not replace an already committed effect with generic cancellation.
        if (
          cancelled &&
          s.controls.interrupting &&
          (stopRequestedBy(s) || (policy.isReadOnly && !policy.isDestructive && policy.replay !== 'never')) &&
          dispatched &&
          (await settlesWithin(dispatched, STOPPED_CALL_REST_MS))
        ) {
          try {
            observation = await dispatched
          } catch {
            /* no receipt: keep dispatch uncertainty */
          }
        }
      }
      if (observation.phase !== 'not_sent') break
      await s.transition([], (cur) =>
        updateCall(cur, call.toolUseId, {
          status: 'dispatch_pending',
          effectId: effect.effectId,
          dispatchAttempt: attempt,
          dispatchPhase: 'not_sent',
        }),
      )
      if (attempt === 2)
        return {
          result: await settleSyntheticDispatch(s, call, effect, attempt, 'not_sent', decisionId, {
            code: 'TOOL_DISPATCH_NOT_SENT',
            message: 'transport did not accept the tool call after two attempts',
            outcome: 'error',
          }),
        }
      if (parent.aborted)
        return {
          result: await settleSyntheticDispatch(s, call, effect, attempt, 'not_sent', decisionId, {
            code: 'CANCELLED',
            message: 'cancelled before dispatch retry',
            outcome: 'aborted',
            cancelledBy: s.d.actor,
          }),
        }
      attempt = 2
      await s.transition([], (cur) =>
        updateCall(cur, call.toolUseId, {
          status: 'dispatch_pending',
          effectId: effect.effectId,
          dispatchAttempt: attempt,
        }),
      )
    }
    if (call.executionDomain === 'host-computer-use')
      await s.transition([], (cur) =>
        updateCall(cur, call.toolUseId, {
          status: 'dispatched',
          effectId: effect.effectId,
          dispatchAttempt: attempt,
          dispatchPhase: 'may_have_sent',
        }),
      )
    let result: ToolResult
    let failed = false
    let settledDispatchPhase: 'may_have_sent' | 'responded' = 'responded'
    if (observation.phase === 'may_have_sent') {
      ac.abort()
      const mutation = policy.isDestructive || !policy.isReadOnly || policy.replay === 'never'
      if (mutation) {
        // A cancel is ours when it is on the ledger: recorded before it is delivered, and a workspace
        // tool such as the shell is told to stop and kills its process group. Once the call has come to
        // rest it is cancelled, not unknown. Whatever cannot show all of that stays unknown: a deadline,
        // a bare abort with no cancel on the ledger, a Host call, and a call still running when the wait ends.
        const stoppedBy = cancelled && call.executionDomain === 'workspace' ? stopRequestedBy(s) : undefined
        if (stoppedBy && dispatched && (await settlesWithin(dispatched, STOPPED_CALL_REST_MS))) {
          const result = await settleSyntheticDispatch(
            s,
            call,
            effect,
            attempt,
            'may_have_sent',
            decisionId,
            {
              code: 'CANCELLED',
              message: userStoppedMessage(call.name),
              outcome: 'aborted',
              partial: true,
              cancelledBy: stoppedBy,
            },
          )
          return {
            result,
            ...(nestedParks[0] ? { park: nestedParks[0] } : {}),
          }
        }
        // Code and `unknown` settlement stay: the call may have changed the world, so it is never replayed.
        const result = await settleSyntheticDispatch(s, call, effect, attempt, 'may_have_sent', decisionId, {
          code: 'TOOL_OUTCOME_UNKNOWN',
          message: unknownOutcomeMessage(
            call.name,
            timedOut ? 'timeout' : cancelled ? 'cancelled' : undefined,
            timeoutMs,
          ),
          outcome: 'unknown',
        })
        return {
          result,
          ...(nestedParks[0] ? { park: nestedParks[0] } : {}),
        }
      }
      if (timedOut || cancelled) {
        const result = await settleSyntheticDispatch(s, call, effect, attempt, 'may_have_sent', decisionId, {
          code: 'CANCELLED',
          message: timedOut ? `timeout: ${call.name}` : `aborted: ${call.name}`,
          outcome: 'aborted',
          partial: true,
          cancelledBy: timedOut ? timeoutActor(s.d.actor) : s.d.actor,
        })
        return {
          result,
          ...(nestedParks[0] ? { park: nestedParks[0] } : {}),
        }
      }
      result = errorResult(
        observation.error instanceof Error ? observation.error.message : String(observation.error),
      )
      failed = true
      settledDispatchPhase = 'may_have_sent'
    } else {
      result = observation.result
    }
    const verdict = await s.d.runtime.verify('tool', await toolVerifyInput(s, call, true), ac.signal)
    // A transform hook: an extension may override the result surfaced to the ledger and to the
    // model, the same `accept`-callback waterfall `context`/`before_request` already use. Verified
    // above against the tool's real, unoverridden result — the hook gets the final say over what is
    // recorded and returned, not over what the verifier judged.
    const hooked = await dispatchLoopEvent(
      s,
      'after_tool_result',
      {
        toolUseId: call.toolUseId,
        name: call.name,
        args: call.args as JsonValue,
        result,
        enforcement: s.d.runtime.enforcement(),
      },
      ac.signal,
    )
    const finalResult = hooked?.result ?? result
    const marker = deferredMarker(finalResult)
    const knownJob = marker.present && marker.jobId ? s.latest('artifact/job', marker.jobId) : undefined
    const deferred = marker.present && marker.jobId && knownJob ? marker.jobId : undefined
    const recordedResult =
      marker.present && !deferred ? errorResult('invalid or unregistered deferred job') : finalResult
    if (marker.present && !deferred) failed = true
    const [loopEffect] = await s.d.log.scan({
      type: 'x/core/loop-effect',
      lane: s.lane,
      fromSeq: call.argsSeq + 1,
      toSeq: call.argsSeq + 1,
      limit: 1,
    })
    const identifiedLoopCall =
      loopEffect?.origin === 'system' &&
      loopEffect.trust === 'trusted' &&
      (loopEffect.data as { toolUseId?: string }).toolUseId === call.toolUseId
    const resultRows: EventInput[] = deferred
      ? [
          s.ev(
            'x/core/deferred-job',
            { jobId: deferred, toolUseId: call.toolUseId },
            { ignorable: true, sourceEventSeqs: [call.argsSeq] },
          ),
          s.ev('effect/intent', {
            effectId: deferredEffectId(deferred, call.toolUseId),
            parentEffectId: effect.effectId,
            kind: 'job',
            tool: { toolUseId: call.toolUseId, name: call.name },
            replay: 'safe',
            argsSeq: call.argsSeq,
          }),
        ]
      : [
          s.ev(
            'tool/result',
            {
              toolUseId: call.toolUseId,
              content: toLedgerContent(
                cancelled
                  ? [
                      {
                        type: 'text',
                        text:
                          policy.isDestructive || !policy.isReadOnly || policy.replay === 'never'
                            ? userStoppedMessage(call.name)
                            : `aborted: ${call.name}`,
                      },
                      ...recordedResult.content,
                    ]
                  : recordedResult.content,
              ),
              ...(() => {
                const refs = recordedResult.content.flatMap((block) =>
                  block.type === 'text' ? [] : [block.ref],
                )
                return refs.length
                  ? {
                      artifactRefs: refs.slice(0, 64),
                      ...(refs.length > 64 ? { artifactRefsTruncated: true as const } : {}),
                    }
                  : {}
              })(),
              ...(recordedResult.structured !== undefined ? { structured: recordedResult.structured } : {}),
              isError: cancelled || recordedResult.isError === true,
              ...(cancelled
                ? { code: 'CANCELLED', partial: true, cancelledBy: stopRequestedBy(s) ?? s.d.actor }
                : {}),
              ...(marker.present ? { code: 'JOB_FAILED' } : {}),
              enforcement: s.d.runtime.enforcement(),
              authz: { decisionId },
            },
            {
              // An open-world tool brings back text the harness did not write, so the row that carries
              // it is untrusted and the request builder wraps it.
              trust: policy.isOpenWorld === false && !attachmentRead ? 'trusted' : 'untrusted',
              origin: `tool:${call.name}`,
              sourceEventSeqs: [call.argsSeq],
            },
          ),
          ...(identifiedLoopCall
            ? [
                s.ev(
                  'x/core/tool-response',
                  { version: 1, toolUseId: call.toolUseId, result: recordedResult },
                  { ignorable: true, sourceEventSeqs: [call.argsSeq] },
                ),
              ]
            : []),
        ]
    const verifierSignal = s.ev('verifier/signal', {
      scope: 'tool',
      tier: s.preset.verifier.defaultTier,
      verdict: verdict.verdict,
      reasons: verdict.reasons,
      toolUseId: call.toolUseId,
    })
    if (settledDispatchPhase === 'may_have_sent') {
      // A workspace/Host call that threw after dispatch keeps the transport fact while preserving
      // the long-standing ordinary tool error contract. It cannot enter `responded`, whose schema
      // requires an actual response attestation, so result and settlement close atomically here.
      await s.transition(
        [...resultRows, effect.settle(effectOutcome({ failed, aborted: cancelled })), verifierSignal],
        (cur) =>
          updateCall(cur, call.toolUseId, {
            status: 'completed',
            effectId: effect.effectId,
            dispatchAttempt: attempt,
            dispatchPhase: settledDispatchPhase,
            ...(recordedResult.terminate ? { terminate: true } : {}),
          }),
      )
    } else if (deferred) {
      // A deferred response has no terminal tool/result row yet. Keep its marker, child intent and
      // parent settlement atomic so recovery never sees `responded` without either a result or a
      // durable job to poll.
      await s.transition(
        [...resultRows, effect.settle(effectOutcome({ failed, aborted: cancelled })), verifierSignal],
        (cur) =>
          updateCall(cur, call.toolUseId, {
            status: 'completed',
            effectId: effect.effectId,
            dispatchAttempt: attempt,
            dispatchPhase: 'responded',
            ...(recordedResult.terminate ? { terminate: true } : {}),
          }),
      )
    } else {
      // The result, its settlement and the completed call are one commit: nothing but building the
      // settlement row runs between them, so a crash leaves the call either dispatched with no
      // result (the window every call already has while it runs) or completed. `responded` is still
      // a state recovery understands, but this path no longer stores it on its own.
      const done = (status: 'responded' | 'completed') => (cur: OpStateObj | null) =>
        updateCall(cur, call.toolUseId, {
          status,
          effectId: effect.effectId,
          dispatchAttempt: attempt,
          dispatchPhase: 'responded',
          ...(recordedResult.terminate ? { terminate: true } : {}),
        })
      await s.transitionChain([
        { events: resultRows, next: done('responded') },
        {
          events: [effect.settle(effectOutcome({ failed, aborted: cancelled })), verifierSignal],
          next: done('completed'),
        },
      ])
    }
    return {
      result: recordedResult,
      ...(nestedParks[0] ? { park: nestedParks[0] } : {}),
      ...(deferred ? { deferred: { jobId: deferred, toolUseId: call.toolUseId } } : {}),
    }
  } finally {
    parent.removeEventListener('abort', onAbort)
    ac.abort()
  }
}

export async function runToolsPhase(s: SessionImpl): Promise<StepOutcome> {
  const op = s.op()
  if (op?.phase.kind !== 'tools') return { phase: op ? (op.phase.kind as StepOutcome['phase']) : 'idle' }
  const t = s.turn
  if (!t) return { phase: 'idle' }
  const batch = op.phase.batch
  const continuation = await approvalContinuation(s)
  // Nested calls are driven synchronously by their parent's ToolContext. They remain in op.state for
  // crash recovery and approval continuation, but must never become independent top-level batch
  // members after reopen.
  const pending = batch.calls.filter(
    (c) => c.status !== 'completed' && ((c.depth ?? 0) === 0 || c.toolUseId === continuation?.toolUseId),
  )
  const last = batch.calls[batch.calls.length - 1]
  const rows = await scanAll((q) => s.d.log.scan(q), {
    fromSeq: batch.assistantSeq + 1,
    toSeq: last ? last.argsSeq : batch.assistantSeq,
    type: 'tool/call',
    lane: s.lane,
  })
  const callsById = new Map(rows.map((e) => [(e.data as { toolUseId: string }).toolUseId, e]))
  const parks: EventInput[] = []
  const runtime = await s.toolRuntime()
  const runtimeCalls = [...pending]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((c) => ({
      id: c.toolUseId,
      name: c.name,
      args: (callsById.get(c.toolUseId)?.data as { args?: JsonValue } | undefined)?.args ?? null,
      concurrencySafe: c.resolvedPolicy?.isConcurrencySafe === true,
    }))
  await runtime.batch(
    structuredClone(runtimeCalls),
    {
      dispatch: async (input, signal): Promise<ToolResult> => {
        const c = pending.find((call) => call.toolUseId === input.id)
        if (!c) throw new CoreError('E_RELATION', 'runtime dispatched an unknown call')
        if (parks.length) return errorResult('parked')
        // The row the arguments live on is not in the scanned window, which means the counter and
        // the ledger disagree about this batch. There is no `tool/call` here to answer, so there is
        // no `tool/result` to write either: the call is dropped loudly rather than executed with
        // `args: undefined`, which would hash an approval against arguments the model never sent.
        const ledgerRow = callsById.get(c.toolUseId)
        if (!ledgerRow) {
          await s.diag('invariant', { kind: 'tool-args-missing', toolUseId: c.toolUseId, name: c.name })
          await s.transition([], (cur) => updateCall(cur, c.toolUseId, { status: 'completed' }))
          return errorResult('tool binding unavailable')
        }
        const ledgerCall = ledgerRow.data as Record<string, unknown>
        const bindingProblem =
          ledgerRow.seq !== c.argsSeq || !hasTrustedToolCallProvenance(ledgerRow)
            ? 'missing'
            : toolPolicyBindingProblem(c, ledgerCall)
        if (bindingProblem) {
          parks.push(
            s.ev(
              'x/core/tool-policy-binding-refused',
              {
                toolUseId: c.toolUseId,
                name: c.name,
                reason: bindingProblem,
              },
              { ignorable: true, sourceEventSeqs: [c.argsSeq] },
            ),
          )
          return errorResult('tool binding unavailable')
        }
        if (!hasCompleteToolPolicyEnvelope(c))
          throw new CoreError('E_RELATION', 'validated tool policy binding became incomplete')
        const recovered =
          c.status === 'dispatch_pending' &&
          c.dispatchAttempt === 2 &&
          c.dispatchPhase === undefined &&
          c.effectId !== undefined
            ? s.state.pendingEffects.get(c.effectId)
            : undefined
        if (c.status === 'dispatch_pending' && c.dispatchAttempt === 2 && !recovered)
          throw new CoreError('E_RELATION', 'attempt-two dispatch lacks its pending effect')
        const r = await s.runNestedTool(
          c.resolvedPolicy.isConcurrencySafe,
          (nestedLease) =>
            approveAndExecute(
              s,
              {
                toolUseId: c.toolUseId,
                name: c.name,
                args: ledgerCall.args,
                ordinal: c.ordinal,
                argsSeq: c.argsSeq,
                resolvedPolicy: c.resolvedPolicy,
                executionDomain: c.executionDomain,
                definitionFingerprint: c.definitionFingerprint,
                policyHash: c.policyHash,
              },
              {
                signal,
                depth: c.depth ?? 0,
                nestedLease,
                // An approval continuation owns a new turn. Preserve the call's durable nesting depth,
                // but do not attach its new effect to the already-settled parent effect from the old turn.
                ...(c.toolUseId !== continuation?.toolUseId && c.parentEffectId
                  ? { parentEffectId: c.parentEffectId }
                  : {}),
                ...(recovered
                  ? {
                      resumeDispatch: {
                        effectId: recovered.effectId,
                        startSeq: recovered.intentSeq,
                        attempt: 2 as const,
                      },
                    }
                  : {}),
              },
            ),
          undefined,
          signal,
        )
        if (r.park) parks.push(r.park)
        return r.result
      },
    },
    s.ac.signal,
  )
  // The marker is durable rather than held only in TurnMemory: a kill after the tool returned but
  // before this batch edge is exactly a deferred-tool resume cut, and must still know which call to poll.
  const deferredRows = await scanAll((q) => s.d.log.scan(q), {
    fromSeq: batch.assistantSeq + 1,
    toSeq: s.lastSeq,
    type: 'x/core/deferred-job',
    lane: s.lane,
  })
  const deferredJobs = deferredRows.flatMap((row) => {
    const data = row.data as { jobId?: unknown; toolUseId?: unknown } | null
    const callSeq = row.sourceEventSeqs?.length === 1 ? row.sourceEventSeqs[0] : undefined
    return typeof data?.jobId === 'string' && typeof data.toolUseId === 'string'
      ? [
          {
            jobId: data.jobId,
            toolUseId: data.toolUseId,
            ...(callSeq === undefined ? {} : { callSeq }),
          },
        ]
      : []
  })
  // One writer closes the batch. The asks, the step's close and the turn's end are one transaction,
  // because a turn left open around an unanswered question is a turn no resume can tell apart from
  // a crash — and a second member writing its own would be writing into a turn already closed.
  if (parks.length) {
    const cur = s.op() as OpStateObj
    const deferredClosers = deferredJobs.flatMap((job) => {
      const callSeq = s.state.toolCalls.get(job.toolUseId)?.seq
      const effectId = deferredEffectId(job.jobId, job.toolUseId)
      const rows: EventInput[] = []
      if (s.state.pendingEffects.has(effectId))
        rows.push(s.ev('effect/settled', { effectId, outcome: 'unknown' }))
      if (callSeq !== undefined)
        rows.push(
          s.ev(
            'tool/result',
            {
              toolUseId: job.toolUseId,
              content: [
                {
                  type: 'text',
                  text: `job ${job.jobId} was still running when the turn parked; its outcome is unknown`,
                },
              ],
              isError: true,
              code: 'TOOL_OUTCOME_UNKNOWN',
              enforcement: s.d.runtime.enforcement(),
              authz: { decisionId: 'n/a' },
            },
            { sourceEventSeqs: [callSeq] },
          ),
        )
      return rows
    })
    await s.endTurn('parked', {
      events: [...parks, ...deferredClosers, s.ev('step/end', { turn: cur.meta.turn, step: cur.step })],
    })
    return { phase: 'terminal', reason: 'parked' }
  }
  // The batch was cut short. Handing the phase back to `step()` would only work when the cancel
  // reached the ledger, and the signal can be pulled without it — so the close is taken here,
  // through the same closer `step()` uses, rather than left to a prologue that may never fire.
  if (s.ac.signal.aborted) return finishAborted(s)
  const cur = s.op() as OpStateObj
  const terminate = cur.phase.kind === 'tools' && cur.phase.batch.calls.some((c) => c.terminate)
  if (deferredJobs.length > 0) {
    await s.transition(
      [],
      withPhase(cur, {
        kind: 'deferred',
        jobs: deferredJobs,
        resumeAfter: {
          kind: 'checkpoint',
          continuation: terminate ? 'may_finish' : 'need_assistant',
          triggerSeq: cur.meta.triggerSeq,
        },
      }),
    )
    return { phase: 'deferred' }
  }
  const stepStartSeq = s.state.openStep.get(s.lane)?.startSeq ?? batch.assistantSeq
  const stepVerdict = await s.d.runtime.verify('step', await stepVerifyInput(s, stepStartSeq), s.ac.signal)
  await s.transition(
    [
      s.ev('verifier/signal', {
        scope: 'step',
        tier: s.preset.verifier.defaultTier,
        verdict: stepVerdict.verdict,
        reasons: stepVerdict.reasons,
      }),
      s.ev('step/end', { turn: cur.meta.turn, step: cur.step }),
    ],
    withPhase(cur, {
      kind: 'checkpoint',
      // A tool that asked to end the turn hands the checkpoint a finished turn to close, rather
      // than another round-trip to the model.
      continuation: terminate ? 'may_finish' : 'need_assistant',
      triggerSeq: cur.meta.triggerSeq,
    }),
  )
  return { phase: 'checkpoint' }
}
