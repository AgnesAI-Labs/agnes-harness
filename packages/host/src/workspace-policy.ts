import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import type { FsPolicy, FsRule } from '@agnes/core'
import { validateFsPolicy } from '@agnes/core'
import { WORKSPACE_SECRET_DIRS } from '@agnes/protocol'

export type WorkspacePathSemantics = Readonly<{
  flavor: 'posix' | 'win32'
  caseSensitive: boolean
}>

export type SandboxStaticConfig = Readonly<{
  level: 'L0' | 'L1'
  required: boolean
  onUnavailable: 'deny' | 'allow'
  extraPaths: readonly string[]
  denyPaths: readonly string[]
  networkAllow: readonly string[]
}>

export type WorkspacePolicyPlan = Readonly<{
  policy: FsPolicy
  staticConfig: SandboxStaticConfig
  staticConfigHash: string
  semantics: WorkspacePathSemantics
  backendOptions: Readonly<{
    cwd: string
    allowPaths: readonly string[]
    denyPaths: readonly string[]
    networkAllow: readonly string[]
  }>
}>

const fault = (reason: string): Error & { code: 'E_SANDBOX_WORKSPACE' } =>
  Object.assign(new Error(`E_SANDBOX_WORKSPACE: ${reason}`), { code: 'E_SANDBOX_WORKSPACE' as const })

const CONFIG_KEYS = new Set([
  'level',
  'required',
  'on_unavailable',
  'extra_paths',
  'deny_paths',
  'network_allow',
])

function stringList(value: unknown, field: string): readonly string[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.includes('\0')))
    throw fault(`sandbox.${field} is not a string list`)
  return Object.freeze([...value])
}

/** The single normalized static sandbox plan consumed by policy compilation and readiness identity. */
export function normalizeSandboxStaticConfig(preset: Readonly<Record<string, unknown>>): SandboxStaticConfig {
  const raw = preset.sandbox
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
    throw fault('sandbox config is not a mapping')
  const input = raw as Record<string, unknown>
  for (const field of Object.keys(input))
    if (!CONFIG_KEYS.has(field)) throw fault(`sandbox config carries unknown key ${field}`)
  const level = input.level ?? 'L0'
  if (level !== 'L0' && level !== 'L1') throw fault('sandbox.level is not L0 or L1')
  const required = input.required ?? false
  if (typeof required !== 'boolean') throw fault('sandbox.required is not boolean')
  const onUnavailable = input.on_unavailable ?? 'deny'
  if (onUnavailable !== 'deny' && onUnavailable !== 'allow')
    throw fault('sandbox.on_unavailable is not deny or allow')
  return Object.freeze({
    level,
    required,
    onUnavailable,
    extraPaths: stringList(input.extra_paths, 'extra_paths'),
    denyPaths: stringList(input.deny_paths, 'deny_paths'),
    networkAllow: stringList(input.network_allow, 'network_allow'),
  })
}

export function sandboxStaticConfigHash(config: SandboxStaticConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'agnes.sandbox-static-config',
        1,
        config.level,
        config.required,
        config.onUnavailable,
        [...config.extraPaths],
        [...config.denyPaths],
        [...config.networkAllow],
      ]),
    )
    .digest('hex')
}

function pathApi(semantics: WorkspacePathSemantics): typeof posix | typeof win32 {
  if (
    (semantics.flavor !== 'posix' && semantics.flavor !== 'win32') ||
    typeof semantics.caseSensitive !== 'boolean'
  )
    throw fault('invalid workspace path semantics')
  return semantics.flavor === 'posix' ? posix : win32
}

function pathIdentity(path: string, semantics: WorkspacePathSemantics): string {
  return semantics.caseSensitive ? path : path.toLocaleLowerCase('en-US')
}

function samePath(left: string, right: string, semantics: WorkspacePathSemantics): boolean {
  return pathIdentity(left, semantics) === pathIdentity(right, semantics)
}

function policyDigest(
  semantics: WorkspacePathSemantics,
  workspaceRoot: string,
  rules: readonly FsRule[],
  networkAllow: readonly string[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'agnes.host-workspace-policy',
        1,
        [semantics.flavor, semantics.caseSensitive],
        pathIdentity(workspaceRoot, semantics),
        rules.map((rule) => [pathIdentity(rule.path, semantics), rule.effect, rule.hard, rule.source]),
        networkAllow,
      ]),
    )
    .digest('hex')
}

/**
 * Compiles and freezes the one policy bound to a session fence. Base receives this policy but no
 * root/config selection input and cannot replace it with a second compiler result.
 */
export async function compileWorkspacePolicy(
  input: Readonly<{
    canonicalRoot: string
    dataDir: string
    homeDir: string
    semantics: WorkspacePathSemantics
    staticConfig: SandboxStaticConfig
    canonicalize(path: string, options?: { base?: string }): Promise<string>
  }>,
): Promise<WorkspacePolicyPlan> {
  const api = pathApi(input.semantics)
  const canonical = async (path: string, field: string, options?: { base?: string }): Promise<string> => {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) throw fault(`invalid ${field}`)
    let resolved: string
    try {
      resolved = await input.canonicalize(path, options)
    } catch {
      throw fault(`${field} cannot be canonicalized`)
    }
    if (!api.isAbsolute(resolved) || api.normalize(resolved) !== resolved)
      throw fault(`${field} is not canonical`)
    return resolved
  }
  const workspaceRoot = await canonical(input.canonicalRoot, 'workspace root')
  if (!samePath(workspaceRoot, input.canonicalRoot, input.semantics))
    throw fault('workspace root identity changed during policy compilation')
  const dataDir = await canonical(input.dataDir, 'data directory')
  const homeDir = await canonical(input.homeDir, 'home directory')
  const below = (base: string, leaf: string, field: string): Promise<string> =>
    canonical(api.join(base, leaf), field)
  const extraAllow = await Promise.all(
    input.staticConfig.extraPaths.map((path) =>
      canonical(path, 'sandbox extra path', { base: workspaceRoot }),
    ),
  )
  const configuredDeny = await Promise.all(
    input.staticConfig.denyPaths.map((path) => canonical(path, 'sandbox deny path', { base: workspaceRoot })),
  )
  const workspaceIsDataDir = samePath(workspaceRoot, dataDir, input.semantics)
  const rules: FsRule[] = [
    { effect: 'allow', path: workspaceRoot, source: 'workspace', hard: false },
    ...(workspaceIsDataDir
      ? []
      : [
          { effect: 'deny' as const, path: dataDir, source: 'data' as const, hard: false },
          {
            effect: 'allow' as const,
            path: await below(dataDir, 'tmp', 'data tmp directory'),
            source: 'data-tmp' as const,
            hard: false,
          },
        ]),
    {
      effect: 'deny',
      path: await below(homeDir, '.ssh', 'home ssh directory'),
      source: 'home-ssh',
      hard: true,
    },
    {
      effect: 'deny',
      path: await below(dataDir, 'secrets', 'data secrets directory'),
      source: 'data-secrets',
      hard: true,
    },
    {
      effect: 'deny',
      path: await below(workspaceRoot, '.git', 'host integrity path'),
      source: 'host-integrity',
      hard: true,
    },
    ...(await Promise.all(
      WORKSPACE_SECRET_DIRS.map(
        async (dir): Promise<FsRule> => ({
          effect: 'deny',
          path: await below(workspaceRoot, dir, 'host integrity path'),
          source: 'host-integrity',
          hard: true,
        }),
      ),
    )),
    ...extraAllow.map((path): FsRule => ({ effect: 'allow', path, source: 'extra', hard: false })),
    ...configuredDeny.map((path): FsRule => ({ effect: 'deny', path, source: 'preset', hard: false })),
  ]
  const networkAllow = Object.freeze([...input.staticConfig.networkAllow])
  const policy: FsPolicy = Object.freeze({
    workspaceRoot,
    rules: Object.freeze(rules.map((rule) => Object.freeze(rule))),
    networkAllow,
    digest: policyDigest(input.semantics, workspaceRoot, rules, networkAllow),
  })
  validateFsPolicy(policy)
  return Object.freeze({
    policy,
    staticConfig: input.staticConfig,
    staticConfigHash: sandboxStaticConfigHash(input.staticConfig),
    semantics: Object.freeze({ ...input.semantics }),
    backendOptions: Object.freeze({
      cwd: workspaceRoot,
      allowPaths: Object.freeze(rules.filter((rule) => rule.effect === 'allow').map((rule) => rule.path)),
      denyPaths: Object.freeze(rules.filter((rule) => rule.effect === 'deny').map((rule) => rule.path)),
      networkAllow,
    }),
  })
}
