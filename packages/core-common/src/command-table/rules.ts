export type PolicyRule = { tool: string; argv: string; action: 'allow' | 'require_approval' | 'deny' }

/** The three words a rule's action can be; the evaluator reads exactly these. */
const ACTIONS = ['allow', 'deny', 'require_approval']

/**
 * The command table a preset states under `approval.command_policy`, read whenever that preset is
 * read into a view, so the table a session enforces is the one its own preset wrote.
 *
 * Every problem is a refusal that names the rule, rather than a skipped rule. A table that cannot be
 * read has to stop the preset from loading: dropping the one rule that failed to compile leaves a
 * policy that looks installed and decides differently from the one that was written, and the
 * direction it differs in is whichever way the missing rule pointed.
 */
export function readCommandRules(raw: unknown): PolicyRule[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error('approval.command_policy must be an array of rules')
  return raw.map((r: PolicyRule, index) => {
    const at = `approval.command_policy[${index}]`
    if (typeof r?.tool !== 'string' || typeof r?.argv !== 'string')
      throw new Error(`${at}: each rule needs a tool and an argv pattern`)
    if (!ACTIONS.includes(r.action)) throw new Error(`${at} (tool ${r.tool}): bad action ${String(r.action)}`)
    // Compiled here so a bad pattern fails the read rather than one call at a time.
    for (const [field, source] of [
      ['tool', r.tool],
      ['argv', r.argv],
    ] as const)
      try {
        new RegExp(source)
      } catch {
        throw new Error(`${at} (tool ${r.tool}): ${field} pattern is not a valid regular expression`)
      }
    // The table anchors tool names itself. An author-supplied anchor is either redundant or evidence
    // the author believed the pattern was unanchored - which is the belief that let `myshell`
    // inherit shell's allow list - so it is refused rather than silently double-anchored.
    if (/[$^]/.test(r.tool)) throw new Error(`${at}: tool pattern must not carry its own anchor: ${r.tool}`)
    return r
  })
}
