import {
  applyRefine,
  type HarnessEntry,
  type OpContext,
  type Operation,
  type RefineLimits,
  type RefineProposal,
  scanAll,
  type VerifierVerdict,
} from '@agnes/core'
import { gateT0 } from './gate.js'
import type { RefineQueue } from './queue.js'

type HarnessConfig = {
  max_entries?: Partial<Record<HarnessEntry['kind'], number>>
  max_chars_per_entry?: number
  auto_refine?: { enabled?: boolean; cooldown_turns?: number; global_needs_human?: boolean }
}

type AfterCoreContext = OpContext & { verifier?: VerifierVerdict }

const DEFAULT_MAX_ENTRIES: Record<HarnessEntry['kind'], number> = {
  prompt: 10,
  memory: 50,
  skill: 30,
  subagent: 10,
}

function readConfig(preset: Record<string, unknown>): {
  harness: HarnessConfig
  limits: RefineLimits
  contractPrefixHash: string
} {
  const harness = (preset.harness ?? {}) as HarnessConfig
  const maxEntries = { ...DEFAULT_MAX_ENTRIES, ...(harness.max_entries ?? {}) }
  for (const [kind, value] of Object.entries(maxEntries)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`harness.max_entries.${kind} must be a non-negative safe integer`)
  }
  const maxCharsPerEntry = harness.max_chars_per_entry ?? 2_000
  if (!Number.isSafeInteger(maxCharsPerEntry) || maxCharsPerEntry < 0)
    throw new Error('harness.max_chars_per_entry must be a non-negative safe integer')
  const contractPrefixHash =
    typeof preset.__contractPrefixHash === 'string' ? preset.__contractPrefixHash : ''
  return {
    harness,
    contractPrefixHash,
    limits: {
      maxEntries,
      maxCharsPerEntry,
      contractPrefixMarkers: ['<contract', ...(contractPrefixHash === '' ? [] : [contractPrefixHash])],
    },
  }
}

async function hasPositiveFeedback(ctx: OpContext): Promise<boolean> {
  const fromSeq = ctx.state?.meta.triggerSeq
  if (fromSeq === undefined) return false
  const rows = await scanAll((q) => ctx.session.scan(q), {
    fromSeq,
    toSeq: ctx.session.lastSeq,
    type: 'feedback/rating',
    lane: ctx.session.lane,
  })
  return rows.some((row) => (row.data as { rating?: unknown }).rating === 'up')
}

async function compactTriggered(ctx: OpContext): Promise<boolean> {
  const fromSeq = ctx.state?.meta.triggerSeq
  if (fromSeq === undefined) return false
  const rows = await ctx.session.scan({
    fromSeq,
    toSeq: ctx.session.lastSeq,
    type: 'x/agnes/refine/compact-trigger',
    lane: ctx.session.lane,
    limit: 1,
  })
  return rows.length > 0
}

async function askForGlobal(ctx: OpContext, proposal: RefineProposal): Promise<boolean> {
  const op = ctx.state
  if (!op) return false
  const asked = {
    requestId: ctx.session.d.ids.requestId(),
    kind: 'refine' as const,
    summary: proposal.rationale,
    risk: 'always' as const,
    bindingHash: '',
    deadline: new Date(ctx.session.d.clock() + ctx.preset.approval.timeoutMs).toISOString(),
  }
  const overridden = ctx.session.hooks.approvalRequest
    ? (
        await ctx.session.hooks.approvalRequest({
          request: {
            tool: 'refine',
            argv: null,
            risk: asked.risk,
            actor: ctx.session.d.actor,
            summary: asked.summary,
          },
        })
      ).request
    : undefined
  const finalAsked = {
    ...asked,
    ...(overridden?.summary === undefined ? {} : { summary: overridden.summary }),
  }
  const verdict = await ctx.session.askApproval(
    {
      ...finalAsked,
      sessionKey: ctx.session.key,
      stepId: `${op.meta.turn}/${op.step}`,
      actor: ctx.session.d.actor,
      taint: op.taint || ctx.session.laneTaint(),
      scope: ctx.session.key,
      context: overridden?.context ?? JSON.stringify({ proposalId: proposal.proposalId }),
    },
    ctx.signal,
  )
  await ctx.session.append(
    typeof verdict === 'object'
      ? [ctx.session.ev('approval/asked', { ...finalAsked, pending: verdict })]
      : [
          ctx.session.ev('approval/asked', finalAsked),
          ctx.session.ev('approval/decided', {
            requestId: finalAsked.requestId,
            verdict,
            via: 'sync',
          }),
        ],
  )
  return verdict === 'allowed-once' || verdict === 'allowed-session'
}

/** Durable queue drain that runs only after the turn's verifier result is known. */
export function refineOperation(deps: { queue: RefineQueue; preset: Record<string, unknown> }): Operation {
  const config = readConfig(deps.preset)
  const auto = config.harness.auto_refine ?? {}
  const cooldownTurns = auto.cooldown_turns ?? 5
  if (!Number.isSafeInteger(cooldownTurns) || cooldownTurns < 0)
    throw new Error('harness.auto_refine.cooldown_turns must be a non-negative safe integer')
  let lastAppliedTurn = Number.NEGATIVE_INFINITY

  return {
    name: 'agnes/refine',
    slot: 'after-core',
    order: 100,
    replay: 'never',
    async applicable(raw) {
      const ctx = raw as AfterCoreContext
      if (auto.enabled === false) return 'not-applicable'
      const proposal = deps.queue.next()
      if (!proposal) return 'skip'
      const turn = ctx.state?.meta.turn
      if (turn === undefined || turn - lastAppliedTurn < cooldownTurns) return 'skip'
      if (proposal.trigger === 'manual' || ctx.verifier?.verdict === 'pass') return 'applied'
      if (await hasPositiveFeedback(ctx)) return 'applied'
      return (await compactTriggered(ctx)) ? 'applied' : 'skip'
    },
    async run(raw) {
      const ctx = raw as AfterCoreContext
      const proposal = deps.queue.next()
      if (!proposal) return {}
      const current = [...ctx.session.state.registers.harnessEntries.values()].map((cell) => cell.value)
      const gate = gateT0(
        proposal,
        {
          maxEntries: config.limits.maxEntries,
          maxCharsPerEntry: config.limits.maxCharsPerEntry,
          contractPrefixHash: config.contractPrefixHash,
        },
        current,
      )
      if (!gate.ok) {
        deps.queue.mark(proposal.proposalId, 'rejected')
        return { note: `refine rejected: ${gate.reason}` }
      }
      const touchesGlobal = proposal.edits.some(
        (edit) => edit.op === 'upsert' && edit.entry.scope === 'global',
      )
      if (touchesGlobal && (auto.global_needs_human ?? true) && !(await askForGlobal(ctx, proposal))) {
        deps.queue.mark(proposal.proposalId, 'rejected')
        return { note: 'refine rejected by human gate' }
      }
      const result = await applyRefine(ctx.session, proposal, config.limits)
      deps.queue.mark(proposal.proposalId, result.outcome === 'applied' ? 'applied' : 'rejected')
      if (result.outcome === 'applied') lastAppliedTurn = ctx.state?.meta.turn ?? lastAppliedTurn
      return {}
    },
  }
}
