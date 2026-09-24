import { CoreError } from '../types.js'
import type { FsOps } from './tool-context.js'

/**
 * The marker a file system uses to say a path was refused by policy, as opposed to missing from
 * disk. It has to be told apart from ENOENT: a probe path that does not exist would make a file
 * system that enforces nothing look like one that refuses everything, and the check would pass by
 * accident on the implementation it exists to catch.
 */
export const FS_DENIED = 'E_FS_DENIED'

/**
 * The sandbox's file policy, as plain data. `path` on every rule is an absolute path produced by
 * the host's canonicalizer - symlinks already resolved, case already the volume's own - and the
 * digest is the policy's content identity, computed by whoever compiled the rules and pinned by
 * the host when it binds them. Core never resolves a path itself: it has no filesystem. What it
 * can do is state the contract (validateFsPolicy), state the precedence rule over canonical
 * strings (decideFsPath) so the compiler and the enforcer cannot drift into two readings of one
 * policy, and hold a real file system to the denials before a session opens (assertFsEnforces).
 */
export type FsRuleSource =
  | 'workspace'
  | 'extra'
  | 'data'
  | 'data-tmp'
  | 'home-ssh'
  | 'data-secrets'
  | 'host-integrity'
  | 'preset'
export type FsRule = {
  effect: 'allow' | 'deny'
  path: string
  source: FsRuleSource
  hard: boolean
}
export type FsPolicy = {
  workspaceRoot: string
  rules: readonly FsRule[]
  networkAllow: readonly string[]
  digest: string
}

export type FsPathDecision =
  | Readonly<{ effect: 'allow' | 'deny'; reason: 'rule' | 'hard-deny'; rule: FsRule }>
  | Readonly<{ effect: 'deny'; reason: 'no-match' }>

/** Whole segments, both separator spellings: the caller hands canonical absolute paths only. */
const segmentsOf = (path: string): string[] => path.split(/[\\/]+/).filter((s) => s !== '')

const fold = (value: string, caseSensitive: boolean): string => (caseSensitive ? value : value.toLowerCase())

const matches = (rule: FsRule, candidate: string, caseSensitive: boolean): boolean => {
  const ruleSegs = segmentsOf(rule.path)
  const candSegs = segmentsOf(candidate)
  if (ruleSegs.length > candSegs.length) return false
  return ruleSegs.every((seg, i) => fold(seg, caseSensitive) === fold(candSegs[i] ?? '', caseSensitive))
}

/**
 * The one precedence rule, over canonical strings: any matching hard deny refuses; otherwise the
 * longest matching rule decides, and at equal depth deny beats allow; nothing matched is a
 * refusal. Comparison is by path segment, so `/work/a` does not contain `/work/ab`. This function
 * never throws and never touches a disk - the candidate must already be canonical, which is the
 * caller's (the file system's) job to make true at operation time.
 */
export function decideFsPath(
  policy: FsPolicy,
  candidate: string,
  opts: { caseSensitive: boolean },
): FsPathDecision {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0'))
    return Object.freeze({ effect: 'deny' as const, reason: 'no-match' as const })
  const matching = policy.rules.filter((rule) => matches(rule, candidate, opts.caseSensitive))
  let hard: FsRule | undefined
  for (const rule of matching)
    if (rule.hard && (!hard || segmentsOf(rule.path).length > segmentsOf(hard.path).length)) hard = rule
  if (hard) return Object.freeze({ effect: 'deny' as const, reason: 'hard-deny' as const, rule: hard })
  let winner: FsRule | undefined
  for (const rule of matching) {
    if (!winner) {
      winner = rule
      continue
    }
    const depth = segmentsOf(rule.path).length
    const best = segmentsOf(winner.path).length
    if (depth > best || (depth === best && rule.effect === 'deny' && winner.effect === 'allow')) winner = rule
  }
  if (!winner) return Object.freeze({ effect: 'deny' as const, reason: 'no-match' as const })
  return Object.freeze({ effect: winner.effect, reason: 'rule' as const, rule: winner })
}

const isAbsolutePath = (p: unknown): p is string =>
  typeof p === 'string' &&
  p.length > 0 &&
  !p.includes('\0') &&
  (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\'))

const samePath = (a: string, b: string): boolean =>
  segmentsOf(a).join('/').toLowerCase() === segmentsOf(b).join('/').toLowerCase()

const RULE_SOURCES: readonly string[] = [
  'workspace',
  'extra',
  'data',
  'data-tmp',
  'home-ssh',
  'data-secrets',
  'host-integrity',
  'preset',
]

/**
 * The startup contract check: what a policy must look like before any file system is asked to
 * enforce it. Every rule path absolute, the workspace allow present, `hard` only ever denying, a
 * well-formed digest, and no two rules disagreeing about one canonical path. A violation is a
 * defect in the seam that compiled the policy, so it refuses initialisation rather than probing.
 */
export function validateFsPolicy(policy: FsPolicy): void {
  const bad = (reason: string): never => {
    throw new CoreError('E_FS_POLICY_INVALID', `the sandbox file policy is not enforceable: ${reason}`, {
      reason,
    })
  }
  if (typeof policy !== 'object' || policy === null) bad('not an object')
  if (!isAbsolutePath(policy.workspaceRoot)) bad('workspaceRoot is not an absolute path')
  if (!Array.isArray(policy.rules) || policy.rules.length === 0) bad('no rules')
  for (const rule of policy.rules) {
    if (typeof rule !== 'object' || rule === null) bad('a rule is not an object')
    if (!isAbsolutePath(rule.path)) bad('a rule path is not an absolute path')
    if (rule.effect !== 'allow' && rule.effect !== 'deny') bad('a rule effect is not allow or deny')
    if (typeof rule.hard !== 'boolean') bad('a rule hard flag is not boolean')
    if (!RULE_SOURCES.includes(rule.source)) bad('a rule source is unknown')
    if (rule.hard && rule.effect !== 'deny') bad('a hard rule does not deny')
  }
  const seen = new Map<string, FsRule>()
  for (const rule of policy.rules) {
    const key = segmentsOf(rule.path).join('/').toLowerCase()
    const prior = seen.get(key)
    if (prior && (prior.effect !== rule.effect || prior.hard !== rule.hard))
      bad('two rules disagree about one canonical path')
    seen.set(key, rule)
  }
  if (!policy.rules.some((rule) => rule.effect === 'allow' && samePath(rule.path, policy.workspaceRoot)))
    bad('no allow rule at the workspace root')
  if (typeof policy.digest !== 'string' || !/^[0-9a-f]{64}$/.test(policy.digest))
    bad('digest is not sha256 hex')
  if (!Array.isArray(policy.networkAllow) || policy.networkAllow.some((h) => typeof h !== 'string'))
    bad('networkAllow is not a string list')
}

/** Folds away `.` and `..` without a platform path module, so a probe path is spelled once. */
function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

function parentOf(root: string): string {
  const cut = root.lastIndexOf('/')
  return cut <= 0 ? '' : root.slice(0, cut)
}

const PROBE = 'agnes-fs-enforcement-probe'

/**
 * The paths a policy-enforcing file system has to refuse, in the spellings that get past a
 * comparison made on the raw string. Every one of them names a file that does not exist, so a
 * conforming implementation answers from the policy without touching a disk. Allow rules are not
 * probed: a policy is held to its denials, and opening something is never the probe's business.
 */
export function enforcementProbes(policy: FsPolicy): string[] {
  const root = normalize(policy.workspaceRoot)
  const probes: string[] = []
  // Outside the root. Asked three ways because an implementation may resolve a relative path
  // against its own root, against a working directory, or not at all - plus a sibling that shares
  // the root's string prefix, which a startsWith fence would wave through.
  if (root !== '/')
    probes.push(
      `../${PROBE}`,
      `${root}/../${PROBE}`,
      `${parentOf(root)}/${PROBE}`,
      `${root}-sibling/${PROBE}`,
    )
  for (const rule of policy.rules) {
    if (rule.effect !== 'deny') continue
    const abs = normalize(rule.path)
    if (abs === '/') continue
    // The entry itself, then the spellings of a file under it. A raw-string comparison catches the
    // plain forms and misses the rest, which is the shape this check exists to make impossible.
    probes.push(abs, `${abs}/${PROBE}`)
    if (abs === root || !abs.startsWith(`${root}/`)) continue
    const rel = abs.slice(root.length + 1)
    probes.push(rel, `${rel}/${PROBE}`, `./${rel}/${PROBE}`, `${PROBE}-elsewhere/../${rel}/${PROBE}`)
  }
  return [...new Set(probes)]
}

/** Whether an error is a file system saying "policy", rather than a file system saying "missing". */
export function isDenial(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { code?: unknown; message?: unknown }
  if (e.code === FS_DENIED) return true
  return typeof e.message === 'string' && e.message.includes(FS_DENIED)
}

/**
 * Holds the supplied file system to the policy the sandbox declared, before a session can use it.
 *
 * The comparison lives in one place - the file system that moves the bytes, which is the only layer
 * that can resolve a symlink or fold case for the volume it is on. What core owes in exchange is
 * that no file system reaches a session without enforcing one, and that is what this discharges.
 * `stat` is the probe because it reads nothing and writes nothing.
 */
export async function assertFsEnforces(fsOps: FsOps, policy: FsPolicy): Promise<void> {
  validateFsPolicy(policy)
  // A file system that refuses its own root refuses everything, and would pass every probe below
  // while being useless. Only a denial fails this: a root that does not exist yet is not the
  // question being asked.
  try {
    await fsOps.stat('.')
  } catch (err) {
    if (isDenial(err))
      throw new CoreError('E_FS_UNENFORCED', 'the file system supplied refuses its own workspace root', {
        workspaceRoot: policy.workspaceRoot,
      })
  }
  for (const path of enforcementProbes(policy)) {
    let refused = false
    try {
      await fsOps.stat(path)
    } catch (err) {
      refused = isDenial(err)
    }
    if (!refused)
      throw new CoreError(
        'E_FS_UNENFORCED',
        `the file system supplied does not refuse ${path}; a refusal must carry ${FS_DENIED}`,
        { path, workspaceRoot: policy.workspaceRoot, digest: policy.digest },
      )
  }
}

/**
 * Asks the file system whether it would refuse this path, without writing anything. It is used
 * where an effect has to happen before the write - the checkpoint snapshot - so that effect does
 * not run for a path the write is about to be refused for. A missing file is not a refusal: the
 * path being written may not exist yet.
 */
export async function assertNotDenied(fsOps: FsOps, path: string): Promise<void> {
  try {
    await fsOps.stat(path)
  } catch (err) {
    if (isDenial(err)) throw err
  }
}
