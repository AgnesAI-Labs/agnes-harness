import type { ToolMeta, ToolResult } from '@agnes/extension-api'
import type { Actor, ApprovalMode, ExecutionDomain, JsonValue, ResolvedToolCallPolicy } from '@agnes/protocol'
import { scanAll } from '../log/scan-pages.js'
import type { ScanQuery } from '../log/storage.js'
import { canonicalJson } from '../request/hash.js'
import {
  approvalBindingHash,
  approvalScopesForCall,
  newPermanentGrant,
  type PersistedToolApproval,
  permanentGrantId,
  permanentGrantMatches,
  sessionGrantKey,
} from '../step/approval-grants.js'
import type { HookPort } from '../step/session.js'
import type { Event, EventInput, Seq } from '../types.js'
import type { EffectRuntime } from './effect.js'
import type { ApprovalRequest, Pending, Verdict } from './seams.js'
import type { SeamRuntime } from './wrap.js'

export interface ToolApprovalCall {
  toolUseId: string
  name: string
  args: unknown
  argsSeq: Seq
  resolvedPolicy: ResolvedToolCallPolicy
  executionDomain: ExecutionDomain
  definitionFingerprint: string
  policyHash: string
}

/** Host-owned ports. No runtime program counter or recovery algorithm crosses this boundary. */
export interface ToolApprovalContext {
  readonly sessionKey: string
  readonly lane: string
  readonly turn: number
  readonly step: number
  readonly actor: Actor
  readonly taint: boolean
  readonly fullAccess: boolean
  readonly approvalMode: ApprovalMode
  readonly approvalTimeoutMs: number
  readonly profileHash: string | null
  readonly lastSeq: Seq
  readonly hooks: Pick<HookPort, 'toolCall' | 'approvalRequest'>
  readonly seams: Pick<
    SeamRuntime,
    'authorize' | 'approvalGrants' | 'approvalPutGrant' | 'ledgerProjected' | 'approvalGuard' | 'ledgerRecord'
  >
  readonly effects: Pick<EffectRuntime, 'start'>
  readonly sessionAllows: Set<string>
  clock(): number
  requestId(): string
  guardianModel(): string
  budgetCap(): number | null
  markLedgerFailed(): void
  scan(query: ScanQuery): Promise<Event[]>
  event(type: string, data: unknown, extra?: Partial<EventInput>): EventInput
  /** Atomically persist audit facts and, when requested, keep the call awaiting execution. */
  commit(events: EventInput[], callState?: 'planned'): Promise<void>
  /** Return only approvals durably bound to this exact call, actor, policy and consumed continuation. */
  persistedApproval(input: {
    toolUseId: string
    args: unknown
    scope: string
    policyHash: string
    policyVersion: string
  }): Promise<PersistedToolApproval | undefined>
  /** Persist the refused result using the owning runtime's call-state transition. */
  refuse(code: string, message: string, decisionId?: string): Promise<ToolResult>
  waitingApproval(waiting: boolean): Promise<void>
  askApproval(request: ApprovalRequest, signal: AbortSignal): Promise<Verdict | Pending>
}

export type ToolApprovalOutcome = { decisionId: string } | { result: ToolResult; park?: EventInput }

const SUBAGENT_TOOLS = new Set(['subagent_fork', 'subagent_spawn', 'subagent_collect', 'subagent_cancel'])
const GUARDIAN_RESERVATION_TOKENS = 1024

/**
 * The shared authorization and approval algorithm. It never dispatches or retries a business tool.
 * The host validates tool identity and the policy envelope before entry. Every guardian intent is
 * committed before the guardian runs; a pending approval is returned for the runtime's parking
 * transaction. The runtime alone owns business-action recovery and subsequent execution.
 */
export async function authorizeToolCall(
  ctx: ToolApprovalContext,
  call: ToolApprovalCall,
  meta: ToolMeta,
  signal: AbortSignal,
): Promise<ToolApprovalOutcome> {
  const policy = call.resolvedPolicy
  // Read from the fold, not from the counter: the counter's copy is a transaction behind the row
  // that taints, so the first call after an untrusted result would be judged against a clean turn.
  const taint = ctx.taint
  const gate = await ctx.hooks.toolCall({
    toolUseId: call.toolUseId,
    name: call.name,
    args: call.args,
    meta,
    actor: ctx.actor,
    taint,
    resolvedPolicy: policy,
    executionDomain: call.executionDomain,
    definitionFingerprint: call.definitionFingerprint,
    policyHash: call.policyHash,
  })
  // A hook denial is not an approval question: nobody is asked, because the answer is already no.
  if (!gate.allow) return { result: await ctx.refuse('HOOK_DENIED', gate.reason) }
  const stepId = `${ctx.turn}/${ctx.step}`
  const risk = policy.requiresApproval
  // A delegated child and its manager run unattended, so taint cannot force an ask nobody answers.
  const isSubagentManagement = SUBAGENT_TOOLS.has(call.name)
  let needsAsk =
    !isSubagentManagement &&
    (risk === 'always' || (risk === 'destructive' && policy.isDestructive) || (taint && !policy.isReadOnly))
  const decision = await ctx.seams.authorize(ctx.actor, 'execute', { kind: 'skill', id: call.name })
  const decisionId = decision.decisionId
  if (decision.effect === 'deny')
    return { result: await ctx.refuse('AUTHZ_DENIED', decision.reason, decisionId) }
  if (decision.effect === 'require_approval') needsAsk = true
  const approvalMode = ctx.approvalMode
  if (ctx.fullAccess || approvalMode === 'off') needsAsk = false // never overrides the deny above
  const scopes = approvalScopesForCall(call.name, policy.approvalScopes)
  const guardianFailed = (
    await scanAll((q) => ctx.scan(q), {
      fromSeq: call.argsSeq,
      toSeq: ctx.lastSeq,
      type: 'x/core/approval-guardian-failed',
      lane: ctx.lane,
    })
  ).some((row) => {
    const failedTool = (row.data as { toolUseId?: unknown } | null)?.toolUseId
    return failedTool === undefined || failedTool === call.toolUseId
  })
  for (const scope of needsAsk ? scopes : []) {
    const bindingHash = approvalBindingHash({
      sessionKey: ctx.sessionKey,
      stepId,
      toolUseId: call.toolUseId,
      args: call.args,
      policyHash: call.policyHash,
      scope,
    })
    const grantKey = sessionGrantKey({
      actor: ctx.actor,
      sessionKey: ctx.sessionKey,
      toolId: call.name,
      scope,
    })
    const profileHash = ctx.profileHash
    const durableBinding =
      profileHash !== null && /^sha256-[a-f0-9]{64}$/.test(profileHash)
        ? {
            actor: ctx.actor,
            profileHash,
            toolId: call.name,
            scope,
            policyVersion: policy.policyVersion,
          }
        : undefined
    const durableGrants = durableBinding
      ? (
          await ctx.seams.approvalGrants(
            {
              profileHash: durableBinding.profileHash,
              actorId: durableBinding.actor.id,
              actorOrg: durableBinding.actor.org,
              toolId: durableBinding.toolId,
              scope: durableBinding.scope,
              policyVersion: durableBinding.policyVersion,
            },
            signal,
          )
        ).filter((grant) => permanentGrantMatches(grant, durableBinding))
      : []
    const recorded = await ctx.persistedApproval({
      toolUseId: call.toolUseId,
      args: call.args,
      scope,
      policyHash: call.policyHash,
      policyVersion: policy.policyVersion,
    })
    if (recorded?.verdict === 'allowed-session') ctx.sessionAllows.add(grantKey)
    if (recorded?.verdict === 'allowed-permanent') {
      if (!durableBinding || !recorded.grantId)
        return {
          result: await ctx.refuse(
            'APPROVAL_GRANT_UNAVAILABLE',
            'permanent approval requires a resolved profile hash',
            decisionId,
          ),
        }
      const alreadyStored = durableGrants.some((grant) => grant.grantId === recorded.grantId)
      const stored =
        alreadyStored ||
        (await ctx.seams.approvalPutGrant(
          newPermanentGrant({
            ...durableBinding,
            grantId: recorded.grantId,
            createdAt: recorded.decidedAt,
          }),
          signal,
        ))
      if (!stored) {
        await ctx.commit([
          ctx.event(
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
        ])
        return {
          result: await ctx.refuse(
            'APPROVAL_GRANT_UNAVAILABLE',
            'permanent approval could not be stored',
            decisionId,
          ),
        }
      }
      const activated = (
        await scanAll((q) => ctx.scan(q), {
          fromSeq: call.argsSeq,
          toSeq: ctx.lastSeq,
          type: 'x/core/approval-grant-activated',
          lane: ctx.lane,
        })
      ).some((row) => {
        const data = row.data as { requestId?: unknown; grantId?: unknown } | null
        return data?.requestId === recorded.requestId && data.grantId === recorded.grantId
      })
      if (!activated)
        await ctx.commit([
          ctx.event(
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
        ])
      continue
    }
    if (recorded?.verdict === 'allowed-once' || recorded?.verdict === 'allowed-session') continue
    if (recorded) {
      return {
        result: await ctx.refuse('APPROVAL_REJECTED', `approval ${recorded.verdict}`, decisionId),
      }
    }
    if (ctx.sessionAllows.has(grantKey) || durableGrants.length > 0) continue
    const priorGuardian = (
      await scanAll((q) => ctx.scan(q), {
        fromSeq: call.argsSeq,
        toSeq: ctx.lastSeq,
        type: 'approval/guardian-decided',
        lane: ctx.lane,
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
        row.actor.id === ctx.actor.id &&
        row.actor.org === ctx.actor.org &&
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
        result: await ctx.refuse(
          'APPROVAL_STATE_INVALID',
          'guardian decision is missing its bound approval decision',
          decisionId,
        ),
      }
    const requestId = priorGuardianData?.requestId ?? ctx.requestId()
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
      summary: `${call.name} ${canonicalJson(call.args).slice(0, 200)}`,
      risk: risk === 'always' ? ('always' as const) : ('destructive' as const),
      bindingHash,
      scope,
      policyVersion: policy.policyVersion,
      ...(durableBinding ? { profileHash: durableBinding.profileHash } : {}),
      options,
      deadline: new Date(ctx.clock() + ctx.approvalTimeoutMs).toISOString(),
    }
    // A transform hook: an extension may adjust risk/context/summary before the question reaches a
    // human, the same waterfall shape `context`/`before_request` already use. `argv` is cast rather
    // than re-validated here because the inference or nested-call entry validated `call.args`
    // before persisting the exact args and resolved policy binding consumed by this dispatch.
    const overridden = ctx.hooks.approvalRequest
      ? (
          await ctx.hooks.approvalRequest({
            request: {
              tool: call.name,
              argv: call.args as JsonValue,
              risk: asked.risk,
              actor: ctx.actor,
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
      sessionKey: ctx.sessionKey,
      stepId,
      tool: { name: call.name, args: call.args, meta },
      actor: ctx.actor,
      taint,
      scope,
      profileHash: ctx.profileHash,
      policyVersion: policy.policyVersion,
      options: [...options],
      ...(overridden?.context !== undefined ? { context: overridden.context } : {}),
    }
    if (approvalMode === 'smart' && !guardianFailed && !priorGuardianData) {
      const guardianModel = ctx.guardianModel()
      const projected = await ctx.seams.ledgerProjected({
        tokensEstimate: GUARDIAN_RESERVATION_TOKENS,
        model: guardianModel,
      })
      const cap = ctx.budgetCap()
      const budgetApproved = Number.isFinite(projected.credits) && (cap === null || projected.credits <= cap)
      const guardian = ctx.effects.start({
        kind: 'approval-guardian',
        tool: { toolUseId: call.toolUseId, name: call.name },
        replay: 'never',
        argsSeq: call.argsSeq,
      })
      await ctx.commit([guardian.intent])
      let guarded = budgetApproved
        ? await ctx.seams.approvalGuard(approvalRequest, signal)
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
        const recorded = await ctx.seams.ledgerRecord({
          ...spend,
          sessionKey: ctx.sessionKey,
          lane: ctx.lane,
          turn: ctx.turn,
          step: ctx.step,
        })
        costEvents.push(ctx.event('cost/ledger', spend))
        if (!recorded) {
          ctx.markLedgerFailed()
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
      await ctx.commit(
        [
          ctx.event('approval/guardian-decided', {
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
                ctx.event('approval/asked', finalAsked),
                ctx.event('approval/decided', {
                  requestId,
                  verdict: guardianVerdict,
                  via: 'guardian',
                  scope,
                }),
              ]
            : []),
        ],
        'planned',
      )
      if (guardianVerdict === 'allowed-once' || guardianVerdict === 'allowed-session') {
        if (guardianVerdict === 'allowed-session') ctx.sessionAllows.add(grantKey)
        continue
      }
      if (guardianVerdict === 'rejected')
        return {
          result: await ctx.refuse('APPROVAL_REJECTED', 'smart guardian rejected the call', decisionId),
        }
    }
    await ctx.waitingApproval(true)
    const verdict = await ctx.askApproval(approvalRequest, signal)
    if (typeof verdict !== 'object' || verdict === null) await ctx.waitingApproval(false)
    if (typeof verdict === 'object') {
      // The ask is handed back rather than written here. Parking closes the turn, and a member of a
      // concurrent batch that closes the turn under its siblings leaves the next one writing a
      // `step/end` into a turn that is already over. One writer ends the batch, and it carries
      // every unanswered question with it rather than dropping the ones that lost the race.
      return {
        result: { content: [{ type: 'text', text: 'parked' }], isError: true },
        park: ctx.event('approval/asked', { ...finalAsked, pending: verdict }),
      }
    }
    const grantId =
      verdict === 'allowed-permanent'
        ? permanentGrantId({ sessionKey: ctx.sessionKey, toolUseId: call.toolUseId, scope })
        : undefined
    await ctx.commit(
      [
        ctx.event('approval/asked', finalAsked),
        ctx.event('approval/decided', {
          requestId,
          verdict,
          via: 'sync',
          scope,
          ...(grantId ? { grantId } : {}),
        }),
      ],
      'planned',
    )
    if (verdict === 'allowed-permanent') {
      const persisted = await ctx.persistedApproval({
        toolUseId: call.toolUseId,
        args: call.args,
        scope,
        policyHash: call.policyHash,
        policyVersion: policy.policyVersion,
      })
      if (!grantId || !durableBinding || !persisted || persisted.grantId !== grantId)
        return {
          result: await ctx.refuse(
            'APPROVAL_STATE_INVALID',
            'permanent approval ledger binding is missing',
            decisionId,
          ),
        }
      const stored = await ctx.seams.approvalPutGrant(
        newPermanentGrant({
          ...durableBinding,
          grantId,
          createdAt: persisted.decidedAt,
        }),
        signal,
      )
      if (!stored) {
        await ctx.commit([
          ctx.event(
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
        ])
        return {
          result: await ctx.refuse(
            'APPROVAL_GRANT_UNAVAILABLE',
            'permanent approval could not be stored',
            decisionId,
          ),
        }
      }
      await ctx.commit([
        ctx.event(
          'x/core/approval-grant-activated',
          { requestId, grantId, toolUseId: call.toolUseId, scope, recovered: false },
          { ignorable: true, sourceEventSeqs: [call.argsSeq] },
        ),
      ])
      continue
    }
    if (verdict === 'allowed-session') ctx.sessionAllows.add(grantKey)
    if (!verdict.startsWith('allowed'))
      return {
        result: await ctx.refuse('APPROVAL_REJECTED', `approval ${verdict}`, decisionId),
      }
  }
  return { decisionId }
}
