import { createHash } from 'node:crypto'
import { win32 } from 'node:path'
import { normalizeWorkspacePath } from '../../tools-core/src/paths.js'

/** Canonical JSON: object keys sorted, so two spellings of one argument object hash alike. */
export function jcs(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${jcs((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}

const PATH_TOOLS = new Set(['read', 'write', 'edit', 'ls', 'grep', 'find'])

/** Thrown when an argument cannot be reduced to one identity, so no decision may be cached under it. */
export class NotCanonical extends Error {
  constructor(reason: string) {
    super(`NotCanonical: ${reason}`)
    this.name = 'NotCanonical'
  }
}

const windowsRoot = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}/.test(path)

/** Lexical identity only. The Host filesystem remains responsible for actual link containment. */
function normalizeWindowsPath(path: string, workspaceRoot: string): string {
  const validate = (value: string): void => {
    if (/^[\\/]{2}[?.][\\/]/.test(value)) throw new NotCanonical('device namespace')
    if (/^[\\/]{2}/.test(value)) {
      const authority = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)(?:[\\/]|$)/.exec(value)
      if (!authority || authority.slice(1).some((part) => part === '.' || part === '..'))
        throw new NotCanonical('incomplete UNC authority')
    }
    const withoutDrive = value.replace(/^[A-Za-z]:[\\/]/, '')
    if (/[<>:"|?*\u2028\u2029]|\p{Cc}/u.test(withoutDrive))
      throw new NotCanonical('ambiguous Windows path characters')
    for (const part of withoutDrive.split(/[\\/]/)) {
      if (part === '' || part === '.' || part === '..') continue
      if (
        /[. ]$/.test(part) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$|CLOCK\$)$/i.test(
          part.split('.')[0]?.trimEnd() ?? '',
        )
      )
        throw new NotCanonical('ambiguous Windows path component')
    }
  }
  validate(workspaceRoot)
  validate(path)
  if (/^[A-Za-z]:(?![\\/])/.test(path) || (/^[\\/]/.test(path) && !/^[\\/]{2}/.test(path)))
    throw new NotCanonical('path depends on a current drive')
  const render = (value: string): string =>
    value.replaceAll('\\', '/').replace(/^[a-z]:/, (drive) => drive.toUpperCase())
  const root = render(win32.normalize(workspaceRoot)).replace(/\/$/, '')
  const volume = render(win32.parse(workspaceRoot).root).replace(/\/$/, '')
  if (!volume || root === volume) throw new NotCanonical('workspace must be narrower than a volume')
  const abs = render(win32.resolve(workspaceRoot, path))
  // Do not use win32.relative here: it folds component case, including on case-sensitive volumes.
  if (abs !== root && !abs.startsWith(`${root}/`)) throw new NotCanonical('path is outside the workspace')
  return abs
}

/**
 * The string a rule is matched against and a grant is bound to.
 *
 * Paths become the containment-checked absolute path, never the workspace-relative one. Relative is
 * sound for deciding containment and is not an identity: where a backslash is an ordinary filename
 * character, the single file `src\a.ts` and the file `a.ts` inside the directory `src` produce the
 * same relative spelling, so a decision cached under it covers a file nobody decided about. What
 * cannot be reduced to one identity is refused outright rather than folded into the table - a
 * refusal reaches a human, a fold does not.
 *
 * The drive-letter refusal is per segment rather than only at the front of the string: `./C:` is one
 * of the spellings that motivated this rule, and a check anchored at the start of the string does
 * not see it.
 */
export function normalizeArgv(tool: string, args: unknown, workspaceRoot: string): string {
  const a = (args ?? {}) as Record<string, unknown>
  if (tool === 'shell' && typeof a.command === 'string') return a.command.trim().replace(/\s+/g, ' ')
  if (PATH_TOOLS.has(tool) && typeof a.path === 'string') {
    const p = a.path
    if (windowsRoot(workspaceRoot)) return normalizeWindowsPath(p, workspaceRoot)
    if (p.includes('\0')) throw new NotCanonical('path contains NUL')
    if (p.includes('\\')) throw new NotCanonical('path contains a backslash')
    if (p.split('/').some((seg) => /^[A-Za-z]:/.test(seg)))
      throw new NotCanonical('path has a segment that reads as a drive letter')
    const n = normalizeWorkspacePath(p, workspaceRoot)
    // Outside the workspace is not the command table's business: the rules there are written about
    // workspace paths, and folding a foreign one into them would answer a question nobody asked.
    if (!n.inside) throw new NotCanonical('path is outside the workspace')
    return n.abs
  }
  // `env` is not stripped. Stripping it let one approval cover calls carrying different
  // environments; no parameter schema declares `env` today, which is why keeping it costs nothing.
  return jcs(a)
}

/**
 * The hash a grant binds to, and the exact string it was taken over. The operator has to be shown
 * what was hashed - otherwise what a human approved and what the system bound are two different
 * objects. A NUL is escaped so the shown string cannot end early on the way to a terminal.
 */
export function argvHash(
  tool: string,
  args: unknown,
  workspaceRoot: string,
): { hash: string; shown: string } {
  const argv = normalizeArgv(tool, args, workspaceRoot)
  return {
    hash: createHash('sha256').update(jcs({ tool, argv })).digest('hex'),
    shown: argv.replace(/\0/g, '\\0'),
  }
}

export type PolicyRule = { tool: string; argv: string; action: 'allow' | 'require_approval' | 'deny' }

/**
 * Anchoring, and why it is asymmetric.
 *
 * The tool name is always fully anchored. A name is an identifier, and an unanchored pattern let
 * every extension tool whose name merely ends in `shell` inherit shell's allow list.
 *
 * The argv is fully anchored for `allow` and searched for `deny` and `require_approval`. An
 * over-broad deny refuses something it need not have; an over-broad allow is a bypass. Unanchored,
 * `^git (status|diff)` allowed `git status; rm -rf /`, and the deny rule sitting beside it never
 * fired because the line begins with `git`.
 */
const anchor = (src: string): RegExp => new RegExp(`^(?:${src})$`)

export function matchPolicy(
  rules: readonly PolicyRule[],
  tool: string,
  argv: string,
): PolicyRule['action'] | undefined {
  const hit = (r: PolicyRule): boolean =>
    anchor(r.tool).test(tool) &&
    (r.action === 'allow' ? anchor(r.argv).test(argv) : new RegExp(r.argv).test(argv))
  // A deny anywhere in the table beats every allow in it, whatever the order they were written in.
  if (rules.some((r) => r.action === 'deny' && hit(r))) return 'deny'
  return rules.find((r) => r.action !== 'deny' && hit(r))?.action
}
