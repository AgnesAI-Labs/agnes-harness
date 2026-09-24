import type { ThinkingLevel } from '@agnes/protocol'

/**
 * The knobs the step machine reads, as one already-resolved view. The preset document itself is
 * snake_case and is validated by the host; this is the camelCase reading of it with every default
 * filled in, so no code downstream has to decide what a missing key means.
 */
export type PresetView = {
  name: string
  disclosure: 'standard' | 'hybrid' | 'code'
  model: {
    /** Omitted retains package defaults; an explicit empty list disables package prompt sections. */
    promptSections?: readonly string[]
    route: Record<string, string>
    thinking: Partial<Record<string, ThinkingLevel>>
    /**
     * The model id a slot asks its route for, when the assembly pins one. A route names an
     * endpoint; a model id names what that endpoint is asked to run, and the two are different
     * strings — a route name is constrained to `^[a-z0-9][a-z0-9-]{0,63}$`, which no `gpt-4.1` or
     * `anthropic/claude-3.5` can satisfy. Empty means the route's own record decides.
     */
    id: Record<string, string>
    retry: { maxAttempts: number; baseDelayMs: number }
    timeoutMs: number
  }
  budget: {
    preflight: 'count' | 'estimate'
    perRequestCap: number | null
    onExceed: 'quote' | 'deny'
    maxSteps: number
  }
  approval: {
    onTimeout: 'rejected'
    timeoutMs: number
    onUnavailable: 'deny' | 'park'
    pendingTtlMs: number
  }
  sandbox: { onUnavailable: 'deny' | 'allow' }
  tools: { timeoutMs: number; timeouts: Record<string, number> }
  verifier: { timeoutMs: number; defaultTier: 0 | 1 | 2 }
  repair: { timeoutMs: number }
  completionGate: { minItems: number }
  compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number; agentCallable: boolean }
  telemetry: { invariants: boolean | 'strict'; timing: boolean }
  recovery: { unknownChild: 'model' | 'human' }
  deferred: { pollMs: number }
  depthLimit: number
  generationLimit: number
  maxFanOut: number
  budgetInherit: 'own' | 'aggregate'
  treeBudgetCredits: number | null
  isolation: 'worktree' | 'shared'
  ext: { eventsPerTurn: number }
}

export function presetDefaults(): PresetView {
  return {
    name: 'standard',
    disclosure: 'standard',
    model: {
      route: { primary: 'default' },
      thinking: {},
      id: {},
      retry: { maxAttempts: 2, baseDelayMs: 1000 },
      timeoutMs: 600000,
    },
    budget: { preflight: 'estimate', perRequestCap: null, onExceed: 'quote', maxSteps: 50 },
    // A timed-out approval reads as a rejection and nothing else: an unanswered prompt must never
    // be the path by which a destructive call proceeds.
    approval: { onTimeout: 'rejected', timeoutMs: 60000, onUnavailable: 'deny', pendingTtlMs: 86400000 },
    sandbox: { onUnavailable: 'deny' },
    tools: { timeoutMs: 120000, timeouts: {} },
    verifier: { timeoutMs: 30000, defaultTier: 0 },
    repair: { timeoutMs: 10000 },
    completionGate: { minItems: 3 },
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, agentCallable: true },
    telemetry: { invariants: false, timing: false },
    recovery: { unknownChild: 'model' },
    deferred: { pollMs: 2000 },
    depthLimit: 2,
    generationLimit: 1,
    maxFanOut: 4,
    budgetInherit: 'aggregate',
    treeBudgetCredits: null,
    isolation: 'shared',
    ext: { eventsPerTurn: 200 },
  }
}

const get = (o: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined),
      o,
    )
const pick = <T>(raw: unknown, path: string, fallback: T): T => {
  const v = get(raw, path)
  return v === undefined ? fallback : (v as T)
}

/**
 * Reads a validated preset document into the view. Only the keys below are read: a preset that
 * spells one differently silently keeps the default rather than half-applying.
 */
export function readPreset(raw: Record<string, unknown>, name: string): PresetView {
  const d = presetDefaults()
  return {
    name,
    disclosure: pick(raw, 'disclosure', d.disclosure),
    model: {
      ...(get(raw, 'model.prompt_sections') === undefined
        ? {}
        : { promptSections: [...pick<string[]>(raw, 'model.prompt_sections', [])] }),
      route: pick(raw, 'model.route', d.model.route),
      thinking: pick(raw, 'model.thinking', d.model.thinking),
      id: pick(raw, 'model.id', d.model.id),
      retry: {
        maxAttempts: pick(raw, 'model.retry.max_attempts', d.model.retry.maxAttempts),
        baseDelayMs: pick(raw, 'model.retry.base_delay_ms', d.model.retry.baseDelayMs),
      },
      timeoutMs: pick(raw, 'model.timeout_ms', d.model.timeoutMs),
    },
    budget: {
      preflight: pick(raw, 'budget.preflight', d.budget.preflight),
      perRequestCap: pick(raw, 'budget.per_request_cap', d.budget.perRequestCap),
      onExceed: pick(raw, 'budget.on_exceed', d.budget.onExceed),
      maxSteps: pick(raw, 'budget.max_steps', d.budget.maxSteps),
    },
    approval: {
      // Not readable from the document: see presetDefaults.
      onTimeout: 'rejected',
      timeoutMs: pick(raw, 'approval.timeout_ms', d.approval.timeoutMs),
      onUnavailable: pick(raw, 'approval.on_unavailable', d.approval.onUnavailable),
      pendingTtlMs: pick(raw, 'approval.pending_ttl_ms', d.approval.pendingTtlMs),
    },
    sandbox: { onUnavailable: pick(raw, 'sandbox.on_unavailable', d.sandbox.onUnavailable) },
    tools: {
      timeoutMs: pick(raw, 'tools.timeout_ms', d.tools.timeoutMs),
      timeouts: pick(raw, 'tools.timeouts', d.tools.timeouts),
    },
    verifier: {
      timeoutMs: pick(raw, 'verifier.timeout_ms', d.verifier.timeoutMs),
      defaultTier: pick(raw, 'verifier.default_tier', d.verifier.defaultTier),
    },
    repair: { timeoutMs: pick(raw, 'repair.timeout_ms', d.repair.timeoutMs) },
    completionGate: { minItems: pick(raw, 'completion_gate.min_items', d.completionGate.minItems) },
    compaction: {
      enabled: pick(raw, 'compaction.enabled', d.compaction.enabled),
      reserveTokens: pick(raw, 'compaction.reserve_tokens', d.compaction.reserveTokens),
      keepRecentTokens: pick(raw, 'compaction.keep_recent_tokens', d.compaction.keepRecentTokens),
      agentCallable: pick(raw, 'compaction.agent_callable', d.compaction.agentCallable),
    },
    telemetry: {
      invariants: pick(raw, 'telemetry.invariants', d.telemetry.invariants),
      timing: pick(raw, 'telemetry.timing', d.telemetry.timing),
    },
    recovery: { unknownChild: pick(raw, 'recovery.unknown_child', d.recovery.unknownChild) },
    deferred: { pollMs: pick(raw, 'deferred.poll_ms', d.deferred.pollMs) },
    // The document counts the depth a subagent may add; the view counts the total, which is what
    // the depth check compares against, so the two differ by the root session itself.
    depthLimit: pick<number>(raw, 'subagent.max_depth', d.depthLimit - 1) + 1,
    generationLimit: pick<number>(raw, 'subagent.max_depth', d.generationLimit),
    maxFanOut: pick<number>(raw, 'subagent.max_fan_out', d.maxFanOut),
    budgetInherit: pick<'own' | 'aggregate'>(raw, 'subagent.budget_inherit', d.budgetInherit),
    treeBudgetCredits: pick<number | null>(raw, 'subagent.tree_budget_credits', d.treeBudgetCredits),
    isolation: pick<'worktree' | 'shared'>(raw, 'subagent.isolation', d.isolation),
    ext: { eventsPerTurn: pick(raw, 'ext.events_per_turn', d.ext.eventsPerTurn) },
  }
}
