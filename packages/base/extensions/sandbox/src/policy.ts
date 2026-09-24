import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'

export type PathSemantics = Readonly<{
  flavor: 'posix' | 'win32'
  caseSensitive: boolean
}>

/**
 * A path identity already resolved by the host's filesystem canonicalizer.
 *
 * This module deliberately does no I/O. It validates and compares the identity, but cannot turn a
 * lexical path into a real one or prove that an operation used it.
 */
export type CanonicalPath = Readonly<{
  value: string
  root: string
  segments: readonly string[]
  flavor: PathSemantics['flavor']
  caseSensitive: boolean
}>

export type RuleSource =
  | 'workspace'
  | 'extra'
  | 'data'
  | 'data-tmp'
  | 'home-ssh'
  | 'data-secrets'
  | 'host-integrity'
  | 'preset'

export type PathRule = Readonly<{
  effect: 'allow' | 'deny'
  hard: boolean
  path: CanonicalPath
  source: RuleSource
}>

export type PathPolicy = Readonly<{
  semantics: PathSemantics
  rules: readonly PathRule[]
  digest: string
}>

export type PathDecision =
  | Readonly<{ effect: 'allow' | 'deny'; reason: 'rule' | 'hard-deny'; rule: PathRule }>
  | Readonly<{ effect: 'deny'; reason: 'no-match' }>

type RuleInput = {
  effect: PathRule['effect']
  hard: boolean
  path: CanonicalPath
  source: RuleSource
}

export type L0PolicyInput = Readonly<{
  workspaceRoot: CanonicalPath
  dataDir: CanonicalPath
  dataTmp: CanonicalPath
  homeSsh: CanonicalPath
  dataSecrets: CanonicalPath
  hostIntegrityDeny: readonly CanonicalPath[]
  extraAllow: readonly CanonicalPath[]
  configuredDeny: readonly CanonicalPath[]
}>

const fault = (reason: string): Error & { code: 'E_SANDBOX_POLICY' } =>
  Object.assign(new Error(`E_SANDBOX_POLICY: ${reason}`), { code: 'E_SANDBOX_POLICY' as const })

const fold = (value: string, caseSensitive: boolean): string =>
  caseSensitive ? value : value.toLocaleLowerCase('en-US')

const compatible = (left: CanonicalPath, right: CanonicalPath): boolean =>
  left.flavor === right.flavor && left.caseSensitive === right.caseSensitive

const contains = (root: CanonicalPath, candidate: CanonicalPath): boolean => {
  if (!compatible(root, candidate)) return false
  if (fold(root.root, root.caseSensitive) !== fold(candidate.root, candidate.caseSensitive)) return false
  if (root.segments.length > candidate.segments.length) return false
  return root.segments.every(
    (segment, index) =>
      fold(segment, root.caseSensitive) === fold(candidate.segments[index] ?? '', root.caseSensitive),
  )
}

/**
 * Accepts a host-canonical path and records the comparison semantics that produced it.
 * Non-normalized input is rejected instead of normalized here: normalization without realpath is
 * not canonicalization and would let policy tests certify a different name than HostFs opens.
 */
export function canonicalPath(value: string, semantics: PathSemantics): CanonicalPath {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    (semantics.flavor !== 'posix' && semantics.flavor !== 'win32') ||
    typeof semantics.caseSensitive !== 'boolean'
  )
    throw fault('invalid canonical path')
  const api = semantics.flavor === 'posix' ? posix : win32
  if (!api.isAbsolute(value) || api.normalize(value) !== value) throw fault('non-canonical path')
  const root = api.parse(value).root
  if (root.length === 0 || (value.length > root.length && value.endsWith(api.sep)))
    throw fault('non-canonical path')
  const rest = value.slice(root.length)
  const segments = rest === '' ? [] : rest.split(api.sep)
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    throw fault('non-canonical path')
  return Object.freeze({
    value,
    root,
    segments: Object.freeze(segments),
    flavor: semantics.flavor,
    caseSensitive: semantics.caseSensitive,
  })
}

function assertCompatible(reference: CanonicalPath, candidate: CanonicalPath): void {
  if (!compatible(reference, candidate)) throw fault('mixed path semantics')
}

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const pathIdentity = (path: CanonicalPath): string => fold(path.value, path.caseSensitive)

function compareRules(left: PathRule, right: PathRule): number {
  return (
    compareText(pathIdentity(left.path), pathIdentity(right.path)) ||
    compareText(left.effect, right.effect) ||
    Number(left.hard) - Number(right.hard) ||
    compareText(left.source, right.source) ||
    // Equivalent case-insensitive spellings have one deterministic representative in `rules` too,
    // even though the digest below deliberately hashes their folded identity.
    compareText(left.path.value, right.path.value)
  )
}

function policyDigest(semantics: PathSemantics, rules: readonly PathRule[]): string {
  // Arrays make field order explicit and JSON supplies unambiguous length/escaping boundaries.
  // The version tag prevents a future wire-shape change from silently retaining an old identity.
  const canonical = JSON.stringify([
    'agnes.path-policy',
    1,
    [semantics.flavor, semantics.caseSensitive],
    rules.map((rule) => [pathIdentity(rule.path), rule.effect, rule.hard, rule.source]),
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

export function createPathPolicy(inputs: readonly RuleInput[]): PathPolicy {
  if (inputs.length === 0) throw fault('empty policy')
  const reference = inputs[0]?.path
  if (!reference) throw fault('empty policy')
  const dispositionByPath = new Map<string, Pick<PathRule, 'effect' | 'hard'>>()
  const unique = new Map<string, RuleInput>()
  for (const input of inputs) {
    assertCompatible(reference, input.path)
    if (input.hard && input.effect !== 'deny') throw fault('hard rules must deny')
    const identity = pathIdentity(input.path)
    const disposition = dispositionByPath.get(identity)
    if (disposition && (disposition.effect !== input.effect || disposition.hard !== input.hard))
      throw fault('conflicting rules for canonical path')
    dispositionByPath.set(identity, { effect: input.effect, hard: input.hard })

    const key = JSON.stringify([identity, input.effect, input.hard, input.source])
    const duplicate = unique.get(key)
    if (!duplicate || compareText(input.path.value, duplicate.path.value) < 0) unique.set(key, input)
  }
  const rules = [...unique.values()].map((input): PathRule => Object.freeze({ ...input }))
  rules.sort(compareRules)
  const semantics = Object.freeze({ flavor: reference.flavor, caseSensitive: reference.caseSensitive })
  return Object.freeze({
    semantics,
    rules: Object.freeze(rules),
    digest: policyDigest(semantics, rules),
  })
}

export function compileL0Policy(input: L0PolicyInput): PathPolicy {
  const all = [
    input.dataDir,
    input.dataTmp,
    input.homeSsh,
    input.dataSecrets,
    ...input.hostIntegrityDeny,
    ...input.extraAllow,
    ...input.configuredDeny,
  ]
  for (const path of all) assertCompatible(input.workspaceRoot, path)
  if (
    !contains(input.dataDir, input.dataTmp) ||
    input.dataDir.segments.length === input.dataTmp.segments.length
  )
    throw fault('data tmp must be below data dir')
  if (!contains(input.dataDir, input.dataSecrets)) throw fault('data secrets must be below data dir')
  if (input.hostIntegrityDeny.some((path) => !contains(input.workspaceRoot, path)))
    throw fault('host integrity deny must be below workspace')

  return createPathPolicy([
    { effect: 'allow', hard: false, path: input.workspaceRoot, source: 'workspace' },
    { effect: 'deny', hard: false, path: input.dataDir, source: 'data' },
    { effect: 'allow', hard: false, path: input.dataTmp, source: 'data-tmp' },
    { effect: 'deny', hard: true, path: input.homeSsh, source: 'home-ssh' },
    { effect: 'deny', hard: true, path: input.dataSecrets, source: 'data-secrets' },
    ...input.hostIntegrityDeny.map(
      (path): RuleInput => ({ effect: 'deny', hard: true, path, source: 'host-integrity' }),
    ),
    ...input.extraAllow.map((path): RuleInput => ({ effect: 'allow', hard: false, path, source: 'extra' })),
    ...input.configuredDeny.map(
      (path): RuleInput => ({ effect: 'deny', hard: false, path, source: 'preset' }),
    ),
  ])
}

const moreSpecific = (left: PathRule, right: PathRule): boolean =>
  left.path.segments.length > right.path.segments.length

export function decidePath(policy: PathPolicy, candidate: CanonicalPath): PathDecision {
  const sample = policy.rules[0]?.path
  if (!sample) throw fault('empty policy')
  assertCompatible(sample, candidate)
  const matching = policy.rules.filter((rule) => contains(rule.path, candidate))
  let hard: PathRule | undefined
  for (const rule of matching) {
    if (rule.hard && (!hard || moreSpecific(rule, hard))) hard = rule
  }
  if (hard) return Object.freeze({ effect: 'deny', reason: 'hard-deny', rule: hard })

  let winner: PathRule | undefined
  for (const rule of matching) {
    if (
      !winner ||
      moreSpecific(rule, winner) ||
      (rule.path.segments.length === winner.path.segments.length &&
        rule.effect === 'deny' &&
        winner.effect === 'allow')
    )
      winner = rule
  }
  if (!winner) return Object.freeze({ effect: 'deny', reason: 'no-match' })
  return Object.freeze({ effect: winner.effect, reason: 'rule', rule: winner })
}

import type { FsPolicy } from '@agnes/core'
import { WORKSPACE_SECRET_DIRS } from '@agnes/protocol'

/**
 * The preset's `sandbox` section, validated. Anything malformed - a wrong type, an unknown key, a
 * smuggled private key - is an E_SEAM_INIT refusal, never a default: this section is the
 * deployment's statement about process isolation, and guessing at it is how a deny posture turns
 * into a silent allow.
 */
export type SandboxConfig = Readonly<{
  level: 'L0' | 'L1'
  required: boolean
  onUnavailable: 'deny' | 'allow'
  extraPaths: readonly string[]
  denyPaths: readonly string[]
  networkAllow: readonly string[]
}>

const seamFault = (reason: string): Error & { code: 'E_SEAM_INIT' } =>
  Object.assign(new Error(`E_SEAM_INIT: ${reason}`), { code: 'E_SEAM_INIT' as const })

const SANDBOX_CONFIG_KEYS = new Set([
  'level',
  'required',
  'on_unavailable',
  'extra_paths',
  'deny_paths',
  'network_allow',
])

export function readSandboxConfig(preset: Record<string, unknown>): SandboxConfig {
  const raw: unknown = preset.sandbox
  if (raw === undefined)
    return Object.freeze({
      level: 'L0',
      required: false,
      onUnavailable: 'deny',
      extraPaths: Object.freeze([]),
      denyPaths: Object.freeze([]),
      networkAllow: Object.freeze([]),
    })
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw seamFault('sandbox config is not a mapping')
  const cfg = raw as Record<string, unknown>
  for (const key of Object.keys(cfg))
    if (!SANDBOX_CONFIG_KEYS.has(key)) throw seamFault('sandbox config carries an unknown key')
  const level = cfg.level ?? 'L0'
  if (level !== 'L0' && level !== 'L1') throw seamFault('sandbox.level is not L0 or L1')
  const required = cfg.required ?? false
  if (typeof required !== 'boolean') throw seamFault('sandbox.required is not boolean')
  const onUnavailable = cfg.on_unavailable ?? 'deny'
  if (onUnavailable !== 'deny' && onUnavailable !== 'allow')
    throw seamFault('sandbox.on_unavailable is not deny or allow')
  const stringList = (value: unknown, name: string): readonly string[] => {
    if (value === undefined) return Object.freeze([])
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
      throw seamFault(`sandbox.${name} is not a string list`)
    return Object.freeze([...value])
  }
  return Object.freeze({
    level,
    required,
    onUnavailable,
    extraPaths: stringList(cfg.extra_paths, 'extra_paths'),
    denyPaths: stringList(cfg.deny_paths, 'deny_paths'),
    networkAllow: stringList(cfg.network_allow, 'network_allow'),
  })
}

/**
 * Compiles the L0 rule set. The canonicalizer is injected - the host's filesystem resolver in a
 * real assembly, a lexical double in tests - because this module stays pure: it produces the
 * policy, and policy is not enforcement. Relative extra/deny entries are defined against the
 * workspace root; every root is canonicalized before a rule is written from it, and any input the
 * canonicalizer or the rule compiler refuses is E_SEAM_INIT, not a policy with a hole in it.
 * Asynchronous because the host resolver walks the live filesystem; the module itself still
 * touches no file.
 */
export async function resolvePolicy(input: {
  config: SandboxConfig
  workspaceRoot: string
  dataDir: string
  homeDir: string
  semantics: PathSemantics
  canonicalize(path: string, opts?: { base?: string }): Promise<string>
}): Promise<Readonly<{ policy: PathPolicy; fsPolicy: FsPolicy }>> {
  const canon = async (path: unknown, what: string, opts?: { base?: string }): Promise<CanonicalPath> => {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0'))
      throw seamFault(`${what} is not a usable path`)
    let value: string
    try {
      value = await input.canonicalize(path, opts)
    } catch {
      throw seamFault(`${what} cannot be canonicalized`)
    }
    try {
      return canonicalPath(value, input.semantics)
    } catch {
      throw seamFault(`${what} is not canonical after resolution`)
    }
  }
  const workspaceRoot = await canon(input.workspaceRoot, 'workspace root')
  const dataDir = await canon(input.dataDir, 'data directory')
  const homeDir = await canon(input.homeDir, 'home directory')
  const below = (base: CanonicalPath, leaf: string, what: string): Promise<CanonicalPath> =>
    canon(`${base.value}/${leaf}`, what)
  try {
    const policy = compileL0Policy({
      workspaceRoot,
      dataDir,
      dataTmp: await below(dataDir, 'tmp', 'data tmp directory'),
      homeSsh: await below(homeDir, '.ssh', 'home ssh directory'),
      dataSecrets: await below(dataDir, 'secrets', 'data secrets directory'),
      hostIntegrityDeny: [
        await below(workspaceRoot, '.git', 'host integrity path'),
        ...(await Promise.all(
          WORKSPACE_SECRET_DIRS.map((dir) => below(workspaceRoot, dir, 'host integrity path')),
        )),
      ],
      extraAllow: await Promise.all(
        input.config.extraPaths.map((path) => canon(path, 'an extra path', { base: workspaceRoot.value })),
      ),
      configuredDeny: await Promise.all(
        input.config.denyPaths.map((path) => canon(path, 'a deny path', { base: workspaceRoot.value })),
      ),
    })
    const fsPolicy: FsPolicy = Object.freeze({
      workspaceRoot: workspaceRoot.value,
      rules: Object.freeze(
        policy.rules.map((rule) =>
          Object.freeze({
            effect: rule.effect,
            path: rule.path.value,
            source: rule.source,
            hard: rule.hard,
          }),
        ),
      ),
      networkAllow: Object.freeze([...input.config.networkAllow]),
      digest: policy.digest,
    })
    return Object.freeze({ policy, fsPolicy })
  } catch (e) {
    if ((e as { code?: unknown })?.code === 'E_SEAM_INIT') throw e
    // A rule-compiler refusal is a config defect the deployment has to fix, stated with the code
    // initialisation failures carry.
    throw seamFault(`sandbox policy does not compile: ${e instanceof Error ? e.message : String(e)}`)
  }
}
