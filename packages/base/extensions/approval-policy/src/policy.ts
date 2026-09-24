import type { PolicyRule } from './normalize.js'

export type ApprovalConfig = {
  onUnavailable: 'deny' | 'park'
  pendingTtlMs: number
  rules: PolicyRule[]
}

/**
 * `require_approval` is the word, and this evaluator owns it: it is the only thing in the repository
 * that turns a rule into a verdict, so the vocabulary is the one it reads. `ask` was a second
 * spelling of the same action carried by the session validator, and for one version it is still
 * accepted here so a table already written in it keeps deciding rather than silently never firing.
 * Every use of it is reported when the session opens, and the spelling goes away after that.
 */
const ASK_SPELLINGS = ['require_approval', 'ask']
const ACTIONS = ['allow', 'deny', ...ASK_SPELLINGS]

/**
 * The approval keys of the resolved preset, read once at assembly.
 *
 * Every problem here is a refusal rather than a skipped rule. A table that cannot be read has to
 * stop the host: dropping the one rule that failed to compile leaves a policy that looks installed
 * and decides differently from the one that was written, and the direction it differs in is
 * whichever way the missing rule pointed.
 */
export function readApprovalConfig(preset: Record<string, unknown>): ApprovalConfig {
  const a = (preset.approval ?? {}) as Record<string, unknown>
  const raw = a.command_policy
  if (raw !== undefined && !Array.isArray(raw))
    throw new Error('approval.command_policy must be an array of rules')
  const rules = (raw ?? []) as PolicyRule[]
  for (const r of rules) {
    if (typeof r?.tool !== 'string' || typeof r?.argv !== 'string')
      throw new Error(`approval.command_policy: each rule needs a tool and an argv pattern`)
    if (!ACTIONS.includes(r.action))
      throw new Error(`approval.command_policy: bad action ${String(r.action)}`)
    // Compiled here so a bad pattern fails assembly rather than one call at a time.
    new RegExp(r.tool)
    new RegExp(r.argv)
    // The table anchors tool names itself. An author-supplied anchor is either redundant or evidence
    // the author believed the pattern was unanchored - which is the belief that let `myshell`
    // inherit shell's allow list - so it is refused rather than silently double-anchored.
    if (/[$^]/.test(r.tool))
      throw new Error(`approval.command_policy: tool pattern must not carry its own anchor: ${r.tool}`)
  }
  return {
    onUnavailable: a.on_unavailable === 'park' ? 'park' : 'deny',
    pendingTtlMs: typeof a.pending_ttl_ms === 'number' ? a.pending_ttl_ms : 86_400_000,
    rules: rules.map((r) =>
      ASK_SPELLINGS.includes(r.action) ? { ...r, action: 'require_approval' as const } : r,
    ),
  }
}
