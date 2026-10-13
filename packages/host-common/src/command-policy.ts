import { HostError } from './errors.js'

/**
 * The vocabulary the command table's evaluator reads (`readCommandRules` in core-common), validated
 * here when a session opens so a rule spelled in any other word is refused instead of never firing.
 */
export const COMMAND_ACTIONS = ['allow', 'require_approval', 'deny'] as const
export type CommandAction = (typeof COMMAND_ACTIONS)[number]
export type CommandRule = { tool: string; argv: string; action: CommandAction }

/**
 * The argv contract, in the second of the three places it has to hold (protocol states it on the
 * approval field, base enforces it at the producing end in edit/write):
 *
 *   argv is the already-resolved on-disk path, byte for byte. Between resolving and matching,
 *   nothing is percent-decoded, nothing is NFKC/NFKD-normalised, nothing is case-folded.
 *
 * Every transform is a way for a string that is not the allowed path to become the allowed path
 * after the decision was made. A full-codepoint scan found a single-character NFKC escape (U+2025,
 * TWO DOT LEADER, which normalises to "..") - so this is far wider than percent-encoding. The same
 * scan confirmed NFC/NFD produce no codepoint containing "." "/" or "\\", which is why filesystem
 * folding cannot turn a permitted string into "..". There is deliberately no normalisation helper in
 * this file: the way this rule gets broken is by someone adding one. A boundary test forbids
 * `normalize('NFK*')` and `decodeURI*` across the whole of src/.
 *
 * Validated when the session opens, not when the first approval arrives: a rule that cannot decide
 * anything must not sit in a preset looking like a policy. An `allow` rule in particular has to be
 * anchored and has to require an absolute path, because the string it is matched against is one.
 */
export function checkCommandRule(rule: CommandRule): void {
  const bad = (why: string): never => {
    throw new HostError('E_PRESET_UNSUPPORTED', `approval.command_policy rule for ${rule.tool} is ${why}`, {
      detail: { capability: 'approval.command_policy', tool: rule.tool, reason: why },
    })
  }
  try {
    new RegExp(rule.argv)
    new RegExp(`^(?:${rule.tool})$`)
  } catch {
    bad('not a valid regular expression')
  }
  // An action the evaluator does not know decides nothing: a rule spelled otherwise simply never
  // fires, so a table that reads as a policy is not one. Refused here rather than at the first call
  // it fails to decide.
  if (!(COMMAND_ACTIONS as readonly string[]).includes(rule.action))
    bad(`not one of the actions ${COMMAND_ACTIONS.join(', ')}`)
  if (!rule.argv.startsWith('^')) bad('not anchored at the start of the path')
  // An allow rule that a relative path can satisfy is one resolved against a cwd it never saw.
  if (rule.action === 'allow' && !requiresAbsolutePath(rule.argv))
    bad('an allow rule must require an absolute path')
}

/**
 * Whether an anchored pattern can only match an absolute path: a leading separator, a leading drive
 * letter and its colon, or a character class that can match nothing but a separator - or one
 * standing in for the drive letter, which the colon after it identifies.
 *
 * A bare `^[` is not one of those, and treating it as one is what this replaces: `^[a-z]+/` and
 * `^[.]{2}/` were both accepted as allow rules, and the second matches the relative traversal `../`
 * that the check exists to refuse. A negated class matches everything outside itself and can insist
 * on nothing.
 *
 * Two more ways the leading token can turn out not to be required, both checked before trusting it:
 * a quantifier right after it (`?`, `*`, `{0}`, `{0,..}`) that allows zero occurrences, and a `|`
 * anywhere at the top level of the pattern - outside every group and character class - which splits
 * the whole regex into alternatives the leading `^` only covers one of.
 */
function requiresAbsolutePath(argv: string): boolean {
  if (hasTopLevelAlternation(argv)) return false
  const body = argv.slice(1)
  // A backslash is a regex escape: only `\/` and `\\` stand for a separator, `\w` or `\S` do not.
  const lit = /^(?:\/|\\[/\\]|[A-Za-z]:)/.exec(body)
  if (lit && !isOptionalHere(body.slice(lit[0].length))) return true
  const cls = /^\[(\^?)((?:\\.|[^\\\]])*)\]/.exec(body)
  if (!cls || cls[1] === '^') return false
  const afterCls = body.slice(cls[0].length)
  if (isOptionalHere(afterCls)) return false
  if (afterCls.startsWith(':')) return true
  const raw = cls[2] ?? ''
  const members: string[] = []
  for (let i = 0; i < raw.length; i++) members.push((raw[i] === '\\' ? raw[++i] : raw[i]) ?? '')
  return members.length > 0 && members.every((c) => c === '/' || c === '\\')
}

/** Whether a quantifier that accepts zero repetitions sits right here, making whatever precedes it
 * optional rather than required. */
function isOptionalHere(rest: string): boolean {
  return /^(?:[?*]|\{0(?:,\d*)?\})/.test(rest)
}

/** Whether the pattern has a `|` outside every group and character class. Such a `|` divides the
 * whole regex into top-level alternatives, so an absolute-path token earlier in the source only
 * constrains the branch it appears in, not the others. */
function hasTopLevelAlternation(argv: string): boolean {
  let depth = 0
  let inClass = false
  for (let i = 0; i < argv.length; i++) {
    const c = argv[i]
    if (c === '\\') {
      i++
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') inClass = true
    else if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (c === '|' && depth === 0) return true
  }
  return false
}
