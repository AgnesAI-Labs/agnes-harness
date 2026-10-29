import type { PolicyRule } from '@agnes/core-common/command-table/rules'
import { jcs } from '@agnes/core-common/jcs'
import { sha256Hex } from '@agnes/core-common/request/hash'
import { normalizeWorkspacePath } from '@agnes/core-common/workspace-path'

export type { PolicyRule }

const PATH_TOOLS = new Set(['read', 'write', 'edit', 'ls', 'grep', 'find'])

const URI_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i

const unpadded = (digits: string) => digits.replace(/^0+(?=\d)/, '')

/**
 * The identity of a reference whose scheme a tool declared as not naming a workspace path.
 *
 * `session-file://6/1` names the first file of message 6 and `artifact://<sha256>?size=<bytes>` text
 * the output guard cut out of a tool result. On Windows, path normalization read their scheme colon
 * as an ambiguous drive and refused every one of them. Such a reference must still reduce to one
 * identity - a decision cached under one spelling would otherwise cover another - so every accepted
 * form is spelled out here and a declared scheme with no rule is refused rather than folded into
 * some other identity.
 */
function normalizeNonWorkspaceReference(scheme: string, remainder: string): string {
  if (scheme === 'session-file' || scheme === 'session-image') {
    if (remainder === 'list') return `${scheme}://list`
    const reference = /^(\d+)\/(\d+)$/.exec(remainder)
    if (!reference) throw new NotCanonical('not a session attachment reference')
    const [seq = '', index = ''] = reference.slice(1)
    return `${scheme}://${unpadded(seq)}/${unpadded(index)}`
  }
  if (scheme === 'artifact') {
    // The output guard writes `artifact://<sha256>?size=<bytes>`; the digest alone is the other
    // spelling a model tries, and the tool refuses it with a message of its own. Size travels with
    // the digest, so a reference with one is a different identity from the digest alone.
    const artifact = /^([0-9a-f]{64})(?:\?size=(\d{1,16}))?$/i.exec(remainder)
    if (!artifact) throw new NotCanonical('not an artifact reference')
    const [digest = '', size] = artifact.slice(1)
    const sha = digest.toLowerCase()
    return size === undefined ? `artifact://${sha}` : `artifact://${sha}?size=${unpadded(size)}`
  }
  throw new NotCanonical('unrecognized non-workspace scheme')
}

/** Thrown when an argument cannot be reduced to one identity, so no decision may be cached under it. */
export class NotCanonical extends Error {
  constructor(reason: string) {
    super(`NotCanonical: ${reason}`)
    this.name = 'NotCanonical'
  }
}

const windowsRoot = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}/.test(path)

/** Lexical identity only. The Host filesystem remains responsible for actual link containment. */
function normalizeWindowsPath(path: string, workspaceRoot: string, controlledRoot?: string): string {
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
  if (controlledRoot) {
    // Relative spellings keep the original workspace as their base, never the granted root.
    const absolute = normalizeWorkspacePath(path, workspaceRoot).abs
    return normalizeWindowsPath(absolute, controlledRoot)
  }
  const unc = /^[\\/]{2}/.test(workspaceRoot)
  if (unc && /^[A-Za-z]:/.test(path)) throw new NotCanonical('path is outside the workspace')
  const rootParts = workspaceRoot.replaceAll('\\', '/').split('/').filter(Boolean)
  const authority = unc ? `//${rootParts[0]}/${rootParts[1]}` : undefined
  // A UNC share is a volume: parent segments clamp at that share, never at the machine root.
  // Map its suffix to a lexical drive so the shared normalizer keeps that boundary intact.
  const lexicalRoot = unc ? `Z:/${rootParts.slice(2).join('/')}` : workspaceRoot
  let lexicalPath = path
  if (unc && /^[\\/]{2}/.test(path)) {
    const parts = path.replaceAll('\\', '/').split('/').filter(Boolean)
    if (`//${parts[0]}/${parts[1]}` !== authority) throw new NotCanonical('path is outside the workspace')
    lexicalPath = `Z:/${parts.slice(2).join('/')}`
  }
  let normalized: ReturnType<typeof normalizeWorkspacePath>
  try {
    normalized = normalizeWorkspacePath(lexicalPath, lexicalRoot)
  } catch {
    throw new NotCanonical('workspace must be narrower than a volume')
  }
  if (!normalized.inside) throw new NotCanonical('path is outside the workspace')
  return unc ? `${authority}/${normalized.abs.slice(3)}` : normalized.abs
}

/**
 * The string a rule is matched against and a grant is bound to.
 *
 * A tool that runs a command says which argument carries it (`ToolMeta.commandArg`), and that text
 * is the identity, with runs of whitespace folded to one space. A tool that declares nothing is
 * matched on the canonical JSON of all its arguments.
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
 *
 * A `path` carrying a URI scheme the tool declared in `ToolMeta.paths[].nonWorkspaceSchemes` is not
 * a filesystem path at all, so the URI itself is the identity and no platform normalization applies.
 * Only the declared schemes are treated that way: an undeclared one stays an ambiguous path on
 * Windows, exactly as before.
 */
export function normalizeArgv(
  tool: string,
  args: unknown,
  workspaceRoot: string,
  commandArg?: string,
  controlledRoot?: string,
  nonWorkspaceSchemes?: readonly string[],
): string {
  const a = (args ?? {}) as Record<string, unknown>
  const command = commandArg === undefined ? undefined : a[commandArg]
  if (typeof command === 'string') return command.trim().replace(/\s+/g, ' ')
  if (PATH_TOOLS.has(tool) && typeof a.path === 'string') {
    const p = a.path
    const scheme = URI_SCHEME.exec(p)
    const name = scheme?.[1]?.toLowerCase()
    if (scheme && name && nonWorkspaceSchemes?.includes(name))
      return normalizeNonWorkspaceReference(name, p.slice(scheme[0].length))
    if (windowsRoot(workspaceRoot)) return normalizeWindowsPath(p, workspaceRoot, controlledRoot)
    if (p.includes('\0')) throw new NotCanonical('path contains NUL')
    if (p.includes('\\')) throw new NotCanonical('path contains a backslash')
    if (p.split('/').some((seg) => /^[A-Za-z]:/.test(seg)))
      throw new NotCanonical('path has a segment that reads as a drive letter')
    const n = normalizeWorkspacePath(p, workspaceRoot)
    // Only a live Host classification may admit another domain. The original spelling still
    // has to have one canonical identity; this is never a fallback for normalization failures.
    if (!n.inside && (!controlledRoot || !normalizeWorkspacePath(n.abs, controlledRoot).inside))
      throw new NotCanonical('path is outside the workspace')
    return n.abs
  }
  // `env` is not stripped. Stripping it let one approval cover calls carrying different
  // environments; no parameter schema declares `env` today, which is why keeping it costs nothing.
  return jcs(a)
}

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

/**
 * The hash a grant binds to, and the exact string it was taken over. The operator has to be shown
 * what was hashed - otherwise what a human approved and what the system bound are two different
 * objects. A NUL is escaped so the shown string cannot end early on the way to a terminal.
 */
export function argvHash(
  tool: string,
  args: unknown,
  workspaceRoot: string,
  commandArg?: string,
): { hash: string; shown: string } {
  const argv = normalizeArgv(tool, args, workspaceRoot, commandArg)
  return {
    hash: sha256Hex(jcs({ tool, argv })),
    shown: argv.replace(/\0/g, '\\0'),
  }
}
