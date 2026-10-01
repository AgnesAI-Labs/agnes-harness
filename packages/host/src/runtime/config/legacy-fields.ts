import { LEGACY_MANAGED_PATHS, LEGACY_PRESET_PATHS, LEGACY_PROFILE_PATHS } from './legacy-field-paths.js'

export type LegacyKind = 'profile' | 'preset' | 'managed'
export type LegacyLayer = 'builtin' | 'user' | 'workspace' | 'local' | 'flags' | 'managed'
export type FieldDisposition =
  | 'equivalent'
  | 'behavior-correction'
  | 'extension-owned'
  | 'source-declared-only'
  | 'blocked'
export type FieldBucket = 'session' | 'provider' | 'identity'

export type LegacyField = {
  path: string
  target: string
  schema: string
  unit: string
  boundary: string
  recovery: string
  disposition: FieldDisposition
  bucket: FieldBucket
  secret: boolean
  /** An object value is a map of dynamic keys, not one nested schema object. */
  open: boolean
  /** A present value can be stored on the validating fragment. */
  placed: boolean
}

const PROFILE = new Set<string>(LEGACY_PROFILE_PATHS)
const PRESET = new Set<string>(LEGACY_PRESET_PATHS)
const MANAGED = new Set<string>(LEGACY_MANAGED_PATHS)

const OPEN = new Set([
  '/limits',
  '/extensionIsolation/extensions',
  '/packages[]/config',
  '/provider/routes[]/compat',
  '/provider/routes[]/models[]/compat',
  '/provider/routes[]/models[]/headers',
  '/provider/routes[]/models[]/samplingParams',
  '/tools/timeouts',
  '/mcp/servers[]/env',
  '/operations/replace',
])

const SECRET = new Set([
  '/transports[]/tls/cert',
  '/transports[]/tls/key',
  '/transports[]/auth/jwt/secret',
  '/transports[]/auth/sourceAuthSecrets[]',
  '/provider/routes[]/credentialRef',
  '/mcp/servers[]/env',
])

/** Profile limit keys with a real consumer. Any other key blocks that limit. */
export const LEGACY_LIMITS: Readonly<Record<string, { target: string; unit: string; placed: boolean }>> = {
  'daemon.max_workers': { target: 'assembly.process.maxWorkers', unit: 'count', placed: true },
  'worker.idle_evict_ms': { target: 'assembly.process.workerIdleEvictMs', unit: 'ms', placed: true },
  'worker.startup_ms': { target: 'assembly.process.workerStartupMs', unit: 'ms', placed: true },
  'shutdown.grace_ms': { target: 'assembly.process.shutdownGraceMs', unit: 'ms', placed: true },
  'subscribe.buffer_events': { target: 'transport.buffer.events', unit: 'count', placed: false },
  'subscribe.buffer_bytes': { target: 'transport.buffer.bytes', unit: 'bytes', placed: false },
  'jobs.tick_ms': { target: 'scheduler.tickMs', unit: 'ms', placed: false },
  'jobs.lock_ms': { target: 'scheduler.lockMs', unit: 'ms', placed: false },
  'jobs.max_stalled': { target: 'scheduler.maxStalled', unit: 'count', placed: false },
  'lease.ttl_ms': { target: 'lease.writerLeaseTtlMs', unit: 'ms', placed: false },
  'approval.park': { target: 'session.approval.on_unavailable', unit: 'flag', placed: true },
  'cost.credits_per_usd': { target: 'budget.creditsPerUsd', unit: 'credits-per-usd', placed: false },
}

export const MAX_STEPS_FEATURE = 'legacy-primary-decision-budget.v1'
export const SECRET_REFERENCE = /^secret:\/\/[A-Za-z0-9_./-]+$/

const WORKSPACE_PREFIXES = [
  '/approvals/mode',
  '/packages[]/id',
  '/packages[]/source',
  '/packages[]/version',
  '/packages[]/enabled',
  '/packages[]/tombstone',
  '/policy/capabilityCeiling[]',
  '/extensionIsolation/',
  '/computerUse/',
]

export function legacyPaths(kind: LegacyKind): readonly string[] {
  if (kind === 'preset') return LEGACY_PRESET_PATHS
  if (kind === 'managed') return LEGACY_MANAGED_PATHS
  return LEGACY_PROFILE_PATHS
}

export function isLegacyPath(kind: LegacyKind, path: string): boolean {
  if (kind === 'preset') return PRESET.has(path)
  if (kind === 'managed') return MANAGED.has(path)
  return PROFILE.has(path)
}

export function layerAllows(layer: LegacyLayer, path: string): boolean {
  if (layer === 'builtin' || layer === 'user') return PROFILE.has(path)
  if (layer === 'managed') return MANAGED.has(path)
  if (layer === 'local' || layer === 'flags') return path.startsWith('/extensionIsolation/')
  return WORKSPACE_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))
}

export function classifyLegacyField(kind: LegacyKind, path: string): LegacyField {
  if (!isLegacyPath(kind, path)) throw new Error(`unclassified legacy field ${kind} ${path}`)
  if (kind === 'preset') return presetField(path)
  return profileField(path)
}

function profileField(path: string): LegacyField {
  if (path === '/name') return spec(path, 'RuntimeProfile.id', 'name', 'D', 'equivalent', 'identity', true)
  if (path === '/schemaVersion')
    return spec(path, 'RuntimeProfile.schemaVersion', 'legacy-integer', 'D', 'equivalent', 'identity', true)
  if (path === '/extends')
    return spec(path, 'RuntimeProfile.extends', 'profile-digest', 'D', 'equivalent', 'identity', false)
  if (path.startsWith('/packages[]/'))
    return spec(
      path,
      `RuntimeProfile.packages.${leaf(path)}`,
      'package',
      'D',
      'equivalent',
      'identity',
      false,
    )
  if (path.startsWith('/seams/'))
    return spec(path, `selection.${leaf(path)}`, 'package-id', 'D', 'equivalent', 'provider', false)
  if (path.startsWith('/provider/'))
    return spec(path, `provider.${path.slice(1)}`, 'provider', 'D', 'equivalent', 'provider', false)
  if (path.startsWith('/adapters/'))
    return spec(path, `adapter.${path.slice(1)}`, 'adapter', 'D', 'equivalent', 'provider', false)
  if (path.startsWith('/transports[]/'))
    return spec(
      path,
      `transport.${path.slice(1)}`,
      path.endsWith('Ms') ? 'ms' : 'transport',
      'D',
      'equivalent',
      'provider',
      true,
    )
  if (path === '/dataDir' || path === '/cacheDir')
    return spec(path, `storage.${path.slice(1)}`, 'absolute-path', 'D', 'equivalent', 'provider', true)
  if (path === '/limits') return spec(path, 'limits', 'limit', 'D', 'equivalent', 'provider', true)
  if (path.startsWith('/presets/'))
    return spec(
      path,
      `RuntimeProfile.presets.${leaf(path)}`,
      'preset-digest',
      'D',
      'equivalent',
      'identity',
      false,
    )
  if (path.startsWith('/policy/capabilityCeiling'))
    return spec(path, 'policy.capabilityCeiling', 'capability', 'D+I', 'equivalent', 'provider', true)
  if (path === '/policy/workspacePackages')
    return spec(path, 'assembly.workspacePackages', 'enum', 'D+I', 'equivalent', 'provider', true)
  if (path.startsWith('/reconcile/'))
    return spec(
      path,
      `assembly.reconcile.${leaf(path)}`,
      path.endsWith('Ms') ? 'ms' : 'enum',
      'D',
      'equivalent',
      'provider',
      true,
    )
  if (path === '/approvals/mode')
    return spec(path, 'policy.approvals.mode', 'enum', 'D+I', 'equivalent', 'provider', true)
  if (path.startsWith('/computerUse/retention/'))
    return spec(
      path,
      `retention.computerUseRetention.${leaf(path)}`,
      retentionUnit(path),
      'D',
      'equivalent',
      'provider',
      true,
    )
  if (path.startsWith('/computerUse/'))
    return spec(
      path,
      `policy.computerUse.${path.slice('/computerUse/'.length)}`,
      'computer-use',
      'D+I',
      'equivalent',
      'provider',
      true,
    )
  if (path.startsWith('/extensionIsolation/'))
    return spec(
      path,
      `assembly.extensionIsolation.${leaf(path)}`,
      'isolation',
      'D',
      'equivalent',
      'provider',
      true,
    )
  if (path.startsWith('/commandHooks/'))
    return spec(path, `assembly.commandHooks.${leaf(path)}`, 'grant', 'D+I', 'equivalent', 'provider', true)
  if (path === '/packagesDeny[]')
    return spec(path, 'managed.packagesDeny', 'package-id', 'D', 'equivalent', 'provider', true)
  if (path === '/version')
    return spec(path, 'managed.version', 'revision', 'D', 'equivalent', 'identity', true)
  throw new Error(`unclassified legacy field profile ${path}`)
}

function presetField(path: string): LegacyField {
  if (path === '/name') return spec(path, 'RuntimePreset.id', 'name', 'D', 'equivalent', 'identity', true)
  if (path === '/extends')
    return spec(path, 'RuntimePreset.extends', 'preset-digest', 'D', 'equivalent', 'identity', false)
  if (path === '/model/max_tokens')
    return spec(path, 'session.model.max_tokens', 'tokens', 'A', 'blocked', 'session', false)
  if (path === '/budget/max_steps')
    return spec(
      path,
      'session.budget.max_steps',
      'primary-decision-steps',
      'N',
      'equivalent',
      'session',
      true,
    )
  if (path.startsWith('/completion_gate/'))
    return spec(
      path,
      `session.${path.slice(1)}`,
      'completion-gate',
      'N',
      'behavior-correction',
      'session',
      true,
    )
  if (path === '/approval/command_policy[]/action')
    return spec(
      path,
      'session.approval.command_policy.action',
      'enum',
      'A+I',
      'behavior-correction',
      'session',
      true,
    )
  if (path === '/recovery/unknown_child')
    return spec(path, 'session.recovery.unknown_child', 'enum', 'R', 'equivalent', 'session', true)
  if (path === '/telemetry/consent')
    return spec(path, 'session.telemetry.consent', 'enum', 'new-session', 'equivalent', 'session', true)
  if (
    path.startsWith('/ext_ui/') ||
    path.startsWith('/quality/') ||
    path.startsWith('/media/') ||
    path.startsWith('/channel/') ||
    path.startsWith('/cron/')
  )
    return spec(
      path,
      `session.${path.slice(1)}`,
      'declared',
      'consumer',
      'source-declared-only',
      'session',
      true,
    )
  return spec(
    path,
    `session.${path.slice(1)}`,
    presetUnit(path),
    presetBoundary(path),
    'equivalent',
    'session',
    true,
  )
}

function spec(
  path: string,
  target: string,
  unit: string,
  boundary: string,
  disposition: FieldDisposition,
  bucket: FieldBucket,
  placed: boolean,
): LegacyField {
  return {
    path,
    target,
    schema: bucket === 'session' ? 'DefaultSessionParameters' : 'provider-config',
    unit,
    boundary,
    recovery: 'R',
    disposition,
    bucket,
    secret: SECRET.has(path),
    open: OPEN.has(path),
    placed,
  }
}

function leaf(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function retentionUnit(path: string): string {
  if (path.endsWith('Bytes')) return 'bytes'
  if (path.endsWith('Ms')) return 'ms'
  return 'count'
}

function presetUnit(path: string): string {
  if (path.endsWith('_ms') || path.endsWith('Ms')) return 'ms'
  if (path.endsWith('_tokens') || path.endsWith('tokens')) return 'tokens'
  if (path.endsWith('_bytes')) return 'bytes'
  if (path.endsWith('_chars')) return 'utf16-code-units'
  if (path.includes('credits')) return 'credits'
  return 'value'
}

function presetBoundary(path: string): string {
  if (path.startsWith('/sandbox/') || path.startsWith('/approval/') || path.startsWith('/mcp/')) return 'D+A'
  if (path.startsWith('/code_runtime/') || path.startsWith('/subagent/') || path.startsWith('/checkpoint/'))
    return 'D+A'
  if (path.startsWith('/harness/auto_refine/')) return 'T'
  if (path.startsWith('/ext/')) return 'T'
  if (path === '/surfaces[]' || path.startsWith('/operations/')) return 'D'
  return 'N'
}
