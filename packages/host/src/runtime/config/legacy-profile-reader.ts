import { isAbsolute, join } from 'node:path'
import { SLOT_NAMES } from '@agnes/protocol'
import { validateRuntime } from '@agnes/protocol/runtime'
import { parse as parseYaml } from 'yaml'
import { canonicalJson } from '../../profile/canonical.js'
import { DEFAULT_COMPUTER_USE } from '../../profile/computer-use.js'
import {
  classifyLegacyField,
  type FieldDisposition,
  isLegacyPath,
  LEGACY_LIMITS,
  type LegacyKind,
  type LegacyLayer,
  layerAllows,
  legacyPaths,
  MAX_STEPS_FEATURE,
  SECRET_REFERENCE,
} from './legacy-fields.js'

export type FieldSource = 'document' | 'parent' | 'specified-default' | 'absent'

export type Diagnostic = {
  code: string
  path: string
  message: string
}

export type FieldRow = {
  kind: LegacyKind
  path: string
  present: boolean
  source: FieldSource
  layer?: LegacyLayer
  value?: unknown
  target: string
  unit: string
  boundary: string
  disposition: FieldDisposition
  placed: boolean
  notes: string[]
}

export type BlockedValue = {
  path: string
  value: unknown
  reason: string
}

export type ProviderConfig = {
  policy: unknown | null
  retention: unknown | null
  transports: unknown | null
  assembly: unknown | null
  directories: { dataDir: string | null; cacheDir: string | null }
  preserved: BlockedValue[]
  identity: { name: string | null; schemaVersion: number | null }
}

export type Provenance = {
  presetChain: string[]
  layers: { layer: LegacyLayer; name: string }[]
}

export type LegacySource = {
  layer: LegacyLayer
  document: unknown
}

export type ConvertLegacyInput = {
  profiles?: readonly LegacySource[]
  presets?: readonly LegacySource[]
  presetId?: string
  /** Applied only to telemetry.consent, after preset inheritance. */
  consent?: unknown
  /** Deployer home. `~` expands only when this is set. The process home is never read. */
  home?: string
}

export type ConversionBody = {
  diagnostics: Diagnostic[]
  rows: FieldRow[]
  sessionParameters: Record<string, unknown> | null
  sessionBlocked: BlockedValue[]
  providerConfig: ProviderConfig | null
  features: string[]
  provenance: Provenance
  refused: boolean
  /** Set when a present field has no official fragment yet. The read can still be usable. */
  withheld: boolean
}

const LAYER_ORDER: readonly LegacyLayer[] = ['builtin', 'user', 'workspace', 'local', 'flags', 'managed']
const APPROVAL_RANK = { off: 0, smart: 1, manual: 2 } as const
const ISOLATION_RANK = { off: 0, preferred: 1, required: 2 } as const
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const REFUSAL = new Set([
  'unknown_field',
  'layer_field_forbidden',
  'secret_material',
  'home_unresolved',
  'path_not_absolute',
  'retry_conflict',
  'disabled_package_revived',
  'configuration_widens_authority',
  'extends_cycle',
  'extends_missing',
  'extends_depth',
  'extends_forbidden',
  'preset_digest_conflict',
  'duplicate_declaration',
  'schema_invalid',
  'preset_missing',
])
const SESSION_KEYS = [
  'surfaces',
  'model',
  'disclosure',
  'tools',
  'mcp',
  'code_runtime',
  'budget',
  'compaction',
  'checkpoint',
  'sandbox',
  'approval',
  'loop',
  'repair',
  'verifier',
  'completion_gate',
  'subagent',
  'harness',
  'ext_ui',
  'ext',
  'telemetry',
  'recovery',
  'quality',
  'media',
  'channel',
  'cron',
  'locale',
  'hooks',
  'skills_roots',
  'operations',
  'deferred',
] as const

/** Defaults apply only to keys still missing after the extends chain. */
const SESSION_DEFAULTS: ReadonlyArray<readonly [string, unknown]> = [
  ['/disclosure', 'standard'],
  ['/tools/timeout_ms', 120_000],
  ['/tools/output_max_bytes', 32_768],
  ['/tools/timeouts', {}],
  ['/mcp/servers', []],
  ['/mcp/defer', true],
  ['/budget/preflight', 'estimate'],
  ['/budget/per_request_cap', null],
  ['/budget/on_exceed', 'quote'],
  ['/budget/max_steps', null],
  ['/compaction/enabled', true],
  ['/compaction/reserve_tokens', 16_384],
  ['/compaction/keep_recent_tokens', 20_000],
  ['/compaction/agent_callable', true],
  ['/sandbox/level', 'L1'],
  ['/sandbox/required', false],
  ['/sandbox/on_unavailable', 'deny'],
  ['/sandbox/extra_paths', []],
  ['/sandbox/deny_paths', []],
  ['/sandbox/network_allow', []],
  ['/approval/on_unavailable', 'deny'],
  ['/approval/on_timeout', 'rejected'],
  ['/approval/timeout_ms', 60_000],
  ['/approval/pending_ttl_ms', 86_400_000],
  ['/approval/command_policy', []],
  ['/loop/repeat_threshold', 3],
  ['/loop/no_progress_steps', 4],
  ['/verifier/timeout_ms', 30_000],
  ['/verifier/default_tier', 0],
  ['/repair/max_rounds', 5],
  ['/repair/escalate_after', 3],
  ['/repair/timeout_ms', 10_000],
  ['/completion_gate/enabled', true],
  ['/completion_gate/min_items', 3],
  ['/completion_gate/allow_override', true],
  ['/subagent/max_depth', 1],
  ['/subagent/max_fan_out', 4],
  ['/subagent/isolation', 'shared'],
  ['/subagent/budget_inherit', 'aggregate'],
  ['/harness/max_entries/prompt', 10],
  ['/harness/max_entries/memory', 50],
  ['/harness/max_entries/skill', 30],
  ['/harness/max_entries/subagent', 10],
  ['/harness/max_chars_per_entry', 2000],
  ['/harness/queue_max', 20],
  ['/harness/auto_refine/enabled', true],
  ['/harness/auto_refine/gate', 'verifier'],
  ['/harness/auto_refine/global_needs_human', true],
  ['/harness/auto_refine/cooldown_turns', 5],
  ['/ext/events_per_turn', 200],
  ['/telemetry/consent', 'DISABLED'],
  ['/telemetry/invariants', false],
  ['/telemetry/timing', false],
  ['/recovery/unknown_child', 'model'],
  ['/deferred/poll_ms', 2000],
  ['/locale', 'en'],
]

const CAPTURE_KEYS = [
  'maxImageDimension',
  'maxBytesPerImage',
  'maxImagesPerResult',
  'maxImagesPerMutationResult',
  'maxImagesPerModelRequest',
  'maxCapturesPerHour',
] as const

const emptyProvider = (): ProviderConfig => ({
  policy: null,
  retention: null,
  transports: null,
  assembly: null,
  directories: { dataDir: null, cacheDir: null },
  preserved: [],
  identity: { name: null, schemaVersion: null },
})

export function inspectLegacyDocument(
  kind: LegacyKind,
  document: unknown,
): {
  diagnostics: Diagnostic[]
  rows: FieldRow[]
} {
  const diagnostics: Diagnostic[] = []
  const parsed = parseDocument(document, diagnostics, `/${kind}`)
  if (!parsed) return { diagnostics, rows: [] }
  collectUnknown(kind, parsed, diagnostics)
  const rows = legacyPaths(kind).map((path) => rowFor(kind, path, parsed, parsed, parsed, undefined))
  return { diagnostics, rows }
}

export function readLegacyConfiguration(input: ConvertLegacyInput): ConversionBody {
  const diagnostics: Diagnostic[] = []
  const provenance: Provenance = { presetChain: [], layers: [] }
  const profiles = (input.profiles ?? []).map((source) => ({ ...source }))
  const presets = (input.presets ?? []).map((source) => ({ ...source }))
  const provider = emptyProvider()
  const side = { approvalPark: false }
  const profileRows = readProfiles(profiles, input.home, provider, provenance, diagnostics, side)
  const preset = readPreset(
    presets,
    input.presetId,
    input.consent,
    provenance,
    diagnostics,
    side.approvalPark,
  )
  const refused = diagnostics.some((item) => REFUSAL.has(item.code))
  const withheld =
    diagnostics.some((item) => !REFUSAL.has(item.code)) ||
    [...profileRows, ...preset.rows].some((row) => row.present && !row.placed)
  return {
    diagnostics,
    rows: [...profileRows, ...preset.rows],
    sessionParameters: refused ? null : preset.sessionParameters,
    sessionBlocked: refused ? [] : preset.sessionBlocked,
    providerConfig: refused ? null : provider,
    features: refused ? [] : preset.features,
    provenance,
    refused,
    withheld,
  }
}

function readPreset(
  sources: readonly LegacySource[],
  presetId: string | undefined,
  consent: unknown,
  provenance: Provenance,
  diagnostics: Diagnostic[],
  approvalPark: boolean,
): {
  rows: FieldRow[]
  sessionParameters: Record<string, unknown> | null
  sessionBlocked: BlockedValue[]
  features: string[]
} {
  const parsed: { layer: LegacyLayer; doc: Record<string, unknown> }[] = []
  for (const source of sources) {
    const doc = parseDocument(source.document, diagnostics, '/preset')
    if (!doc) continue
    collectUnknown('preset', doc, diagnostics)
    collectSecrets('preset', doc, diagnostics)
    parsed.push({ layer: source.layer, doc })
  }
  if (parsed.length === 0 && presetId === undefined) {
    return { rows: [], sessionParameters: null, sessionBlocked: [], features: [] }
  }
  const byName = indexPresets(parsed, diagnostics)
  if (presetId === undefined) {
    return { rows: [], sessionParameters: null, sessionBlocked: [], features: [] }
  }
  const selected = byName.get(presetId)
  if (!selected) {
    diagnostics.push({
      code: 'preset_missing',
      path: '/name',
      message: `preset ${presetId} is not in the supplied documents`,
    })
    return { rows: [], sessionParameters: null, sessionBlocked: [], features: [] }
  }
  const chain = presetChain(presetId, byName, diagnostics)
  provenance.presetChain = chain.map((item) => stringField(item.doc, 'name') ?? presetId)
  const merged = chain.reduce<Record<string, unknown>>(
    (base, item) => deepMerge(base, item.doc) as Record<string, unknown>,
    {},
  )
  const child = selected.doc
  const effective = structuredClone(merged)
  normalizeRoutes(effective, diagnostics)
  const notes = new Map<string, string[]>()
  applyPresetAliases(merged, effective, notes, diagnostics)
  applySessionDefaults(effective)
  applyConsent(effective, consent, diagnostics)
  if (approvalPark) {
    const approval = recordField(effective, 'approval') ?? {}
    approval.on_unavailable = 'park'
    effective.approval = approval
    const current = notes.get('/approval/on_unavailable') ?? []
    notes.set('/approval/on_unavailable', [...current, 'approval.park 1 is on_unavailable park'])
  }
  const sessionBlocked = blockedSessionValues(merged)
  for (const blocked of sessionBlocked) {
    diagnostics.push({
      code: 'target_schema_missing',
      path: blocked.path,
      message: `${blocked.path} is kept and has no field on the published session parameters`,
    })
  }
  const session = sessionObject(effective)
  const features = sessionFeatures(session)
  const rows = legacyPaths('preset').map((path) =>
    rowFor('preset', path, effective, child, merged, selected.layer, notes.get(path) ?? []),
  )
  if (diagnostics.some((item) => REFUSAL.has(item.code))) {
    return { rows, sessionParameters: null, sessionBlocked, features }
  }
  const validated = validateRuntime('DefaultSessionParameters', session)
  if (!validated.ok) {
    for (const error of validated.errors) {
      diagnostics.push({
        code: 'schema_invalid',
        path: error.path || '/',
        message: `session parameters failed validation (${error.code})`,
      })
    }
    return { rows, sessionParameters: null, sessionBlocked, features }
  }
  if (chain.some((item) => typeof item.doc.extends === 'string')) {
    diagnostics.push({
      code: 'manifest_digest_required',
      path: '/extends',
      message: 'inherited preset content is read, and the parent digest is not issued here',
    })
  }
  return {
    rows,
    sessionParameters: validated.value as Record<string, unknown>,
    sessionBlocked,
    features,
  }
}

function indexPresets(
  parsed: { layer: LegacyLayer; doc: Record<string, unknown> }[],
  diagnostics: Diagnostic[],
): Map<string, { layer: LegacyLayer; doc: Record<string, unknown> }> {
  const byName = new Map<string, { layer: LegacyLayer; doc: Record<string, unknown> }>()
  for (const item of parsed) {
    const name = stringField(item.doc, 'name')
    if (!name || !NAME_PATTERN.test(name)) {
      diagnostics.push({
        code: 'schema_invalid',
        path: '/name',
        message: 'preset name is not a legal identifier',
      })
      continue
    }
    const previous = byName.get(name)
    if (previous && stable(previous.doc) !== stable(item.doc)) {
      diagnostics.push({
        code: 'preset_digest_conflict',
        path: '/name',
        message: `preset ${name} is supplied with two different documents`,
      })
    }
    byName.set(name, item)
  }
  return byName
}

function presetChain(
  name: string,
  byName: Map<string, { layer: LegacyLayer; doc: Record<string, unknown> }>,
  diagnostics: Diagnostic[],
): { layer: LegacyLayer; doc: Record<string, unknown> }[] {
  const seen: string[] = []
  let current = name
  for (let hop = 0; hop <= 16; hop++) {
    if (seen.includes(current)) {
      diagnostics.push({
        code: 'extends_cycle',
        path: '/extends',
        message: `preset extends cycle at ${current}`,
      })
      return seen.flatMap((item) => {
        const found = byName.get(item)
        return found ? [found] : []
      })
    }
    const found = byName.get(current)
    if (!found) {
      diagnostics.push({
        code: 'extends_missing',
        path: '/extends',
        message: `preset parent ${current} is not in the supplied documents`,
      })
      return seen.flatMap((item) => {
        const doc = byName.get(item)
        return doc ? [doc] : []
      })
    }
    seen.push(current)
    const parent = found.doc.extends
    if (parent === undefined) return chainItems(seen, byName)
    if (typeof parent !== 'string' || !NAME_PATTERN.test(parent)) {
      diagnostics.push({
        code: 'schema_invalid',
        path: '/extends',
        message: 'preset extends is not a preset name',
      })
      return chainItems(seen, byName)
    }
    if (parent === 'minimal-rl') {
      diagnostics.push({
        code: 'extends_forbidden',
        path: '/extends',
        message: 'preset extends cannot name minimal-rl',
      })
      return chainItems(seen, byName)
    }
    current = parent
  }
  diagnostics.push({
    code: 'extends_depth',
    path: '/extends',
    message: 'preset extends chain is longer than 16',
  })
  return []
}

function normalizeRoutes(doc: Record<string, unknown>, diagnostics: Diagnostic[]): void {
  const model = recordField(doc, 'model')
  if (!model) return
  const pins = recordField(model, 'id')
  if (model.id !== undefined && !pins) {
    diagnostics.push({ code: 'schema_invalid', path: '/model/id', message: 'model.id must be an object' })
  }
  const route = recordField(model, 'route')
  if (route) {
    for (const [slot, target] of Object.entries(route)) {
      if (!(SLOT_NAMES as readonly string[]).includes(slot)) {
        diagnostics.push({
          code: 'unknown_field',
          path: `/model/route/${slot}`,
          message: `unknown field /model/route/${slot}`,
        })
        continue
      }
      if (typeof target === 'string') {
        const pin = pins?.[slot]
        const next: Record<string, unknown> = { route: target }
        if (typeof pin === 'string' && pin !== 'default') next.model = pin
        route[slot] = next
      }
    }
  }
  if (pins) {
    for (const slot of Object.keys(pins)) {
      if (!(SLOT_NAMES as readonly string[]).includes(slot)) {
        diagnostics.push({
          code: 'schema_invalid',
          path: `/model/id/${slot}`,
          message: `model.id.${slot} is not a route slot`,
        })
      } else if (!route || route[slot] === undefined) {
        diagnostics.push({
          code: 'schema_invalid',
          path: `/model/id/${slot}`,
          message: `model.id.${slot} has no route`,
        })
      }
    }
    delete model.id
  }
}

function applyPresetAliases(
  raw: Record<string, unknown>,
  effective: Record<string, unknown>,
  notes: Map<string, string[]>,
  diagnostics: Diagnostic[],
): void {
  const rawModel = recordField(raw, 'model')
  const model = recordField(effective, 'model')
  const rawRetry = rawModel ? recordField(rawModel, 'retry') : undefined
  const retry = model ? recordField(model, 'retry') : undefined
  if (rawRetry && Object.hasOwn(rawRetry, 'backoff_ms')) {
    notes.set('/model/retry/backoff_ms', ['backoff_ms is an alias of base_delay_ms'])
    if (Object.hasOwn(rawRetry, 'base_delay_ms') && rawRetry.base_delay_ms !== rawRetry.backoff_ms) {
      diagnostics.push({
        code: 'retry_conflict',
        path: '/model/retry/backoff_ms',
        message: 'backoff_ms and base_delay_ms disagree',
      })
    } else if (retry) {
      retry.base_delay_ms = rawRetry.backoff_ms
      delete retry.backoff_ms
      notes.set('/model/retry/base_delay_ms', ['value taken from backoff_ms'])
    }
  }
  const rawRecovery = recordField(raw, 'recovery')
  const recovery = recordField(effective, 'recovery')
  if (rawRecovery?.unknown_child === 'park' && recovery) {
    recovery.unknown_child = 'human'
    notes.set('/recovery/unknown_child', ['park is reported as human'])
  }
  const rawApproval = recordField(raw, 'approval')
  const approval = recordField(effective, 'approval')
  const rules = rawApproval?.command_policy
  if (Array.isArray(rules) && approval && Array.isArray(approval.command_policy)) {
    if (rules.some((rule) => isRecord(rule) && rule.action === 'ask')) {
      notes.set('/approval/command_policy[]/action', ['ask is require_approval'])
    }
    approval.command_policy = approval.command_policy.map((rule) =>
      isRecord(rule) && rule.action === 'ask' ? { ...rule, action: 'require_approval' } : rule,
    )
  }
}

function applySessionDefaults(doc: Record<string, unknown>): void {
  for (const [path, value] of SESSION_DEFAULTS) {
    if (!readPath(doc, path).present) assignPath(doc, path, structuredClone(value))
  }
}

function applyConsent(doc: Record<string, unknown>, consent: unknown, diagnostics: Diagnostic[]): void {
  if (consent === undefined) return
  const value = consentValue(consent, diagnostics)
  if (value === undefined) return
  const telemetry = recordField(doc, 'telemetry') ?? {}
  telemetry.consent = value
  doc.telemetry = telemetry
}

function consentValue(consent: unknown, diagnostics: Diagnostic[]): string | undefined {
  if (typeof consent === 'string') return consent
  if (!isRecord(consent)) {
    diagnostics.push({
      code: 'schema_invalid',
      path: '/telemetry/consent',
      message: 'consent overlay is not an object',
    })
    return undefined
  }
  const keys = Object.keys(consent)
  if (keys.length === 1 && keys[0] === 'consent' && typeof consent.consent === 'string')
    return consent.consent
  const telemetry = recordField(consent, 'telemetry')
  if (
    keys.length === 1 &&
    telemetry &&
    Object.keys(telemetry).length === 1 &&
    typeof telemetry.consent === 'string'
  ) {
    return telemetry.consent
  }
  diagnostics.push({
    code: 'unknown_field',
    path: '/telemetry/consent',
    message: 'consent overlay only accepts telemetry.consent',
  })
  return undefined
}

function blockedSessionValues(raw: Record<string, unknown>): BlockedValue[] {
  const model = recordField(raw, 'model')
  if (!model || !Object.hasOwn(model, 'max_tokens')) return []
  return [{ path: '/model/max_tokens', value: model.max_tokens, reason: 'target_schema_missing' }]
}

function sessionObject(doc: Record<string, unknown>): Record<string, unknown> {
  const session: Record<string, unknown> = {}
  for (const key of SESSION_KEYS) {
    if (Object.hasOwn(doc, key)) session[key] = structuredClone(doc[key])
  }
  const model = recordField(session, 'model')
  if (model) {
    delete model.max_tokens
    delete model.id
    const retry = recordField(model, 'retry')
    if (retry) delete retry.backoff_ms
  }
  return session
}

function sessionFeatures(session: Record<string, unknown>): string[] {
  const budget = recordField(session, 'budget')
  return typeof budget?.max_steps === 'number' ? [MAX_STEPS_FEATURE] : []
}

function readProfiles(
  sources: readonly LegacySource[],
  home: string | undefined,
  provider: ProviderConfig,
  provenance: Provenance,
  diagnostics: Diagnostic[],
  side: { approvalPark: boolean },
): FieldRow[] {
  if (sources.length === 0) return []
  const parsed: { layer: LegacyLayer; doc: Record<string, unknown> }[] = []
  for (const source of sources) {
    const doc = parseDocument(source.document, diagnostics, '/profile')
    if (!doc) continue
    const kind: LegacyKind = source.layer === 'managed' ? 'managed' : 'profile'
    collectUnknown(kind, doc, diagnostics)
    collectSecrets(kind, doc, diagnostics)
    collectForbidden(source.layer, doc, diagnostics)
    parsed.push({ layer: source.layer, doc })
  }
  const folded = foldProfileLayers(parsed, diagnostics)
  const effective: Record<string, unknown> = {}
  const origins = new Map<string, { layer: LegacyLayer; source: FieldSource }>()
  let approval: 'off' | 'smart' | 'manual' | undefined
  let ceiling: string[] | undefined
  let computerUse: Record<string, unknown> | undefined
  const packages = new Map<string, PackageState>()
  const routes = new Set<string>()
  for (const layer of folded) {
    provenance.layers.push({ layer: layer.layer, name: stringField(layer.doc, 'name') ?? layer.layer })
    applyProfileLayer(layer, {
      home,
      effective,
      origins,
      approval,
      ceiling,
      computerUse,
      packages,
      routes,
      provider,
      diagnostics,
      side,
      setApproval(mode) {
        approval = mode
      },
      setCeiling(next) {
        ceiling = next
      },
      setComputerUse(next) {
        computerUse = next
      },
    })
  }
  if (packages.size > 0) {
    effective.packages = [...packages.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
    provider.preserved.push({
      path: '/packages[]',
      value: effective.packages,
      reason: 'manifest_digest_required',
    })
    diagnostics.push({
      code: 'manifest_digest_required',
      path: '/packages[]',
      message: 'package entries stay preserved until a manifest digest exists',
    })
  }
  const rows = legacyPaths('profile').map((path) => profileRow(path, effective, origins))
  if (folded.some((layer) => layer.layer === 'managed')) {
    for (const path of legacyPaths('managed')) {
      if (isLegacyPath('profile', path)) continue
      rows.push(profileRow(path, effective, origins, 'managed'))
    }
  }
  return rows
}

type PackageState = {
  id: string
  enabled: boolean
  tombstone: boolean
  source?: unknown
  version?: unknown
  config?: unknown
}

type ProfileApply = {
  home: string | undefined
  effective: Record<string, unknown>
  origins: Map<string, { layer: LegacyLayer; source: FieldSource }>
  approval: 'off' | 'smart' | 'manual' | undefined
  ceiling: string[] | undefined
  computerUse: Record<string, unknown> | undefined
  packages: Map<string, PackageState>
  routes: Set<string>
  provider: ProviderConfig
  diagnostics: Diagnostic[]
  side: { approvalPark: boolean }
  setApproval: (mode: 'off' | 'smart' | 'manual') => void
  setCeiling: (next: string[]) => void
  setComputerUse: (next: Record<string, unknown>) => void
}

function foldProfileLayers(
  parsed: { layer: LegacyLayer; doc: Record<string, unknown> }[],
  diagnostics: Diagnostic[],
): { layer: LegacyLayer; doc: Record<string, unknown> }[] {
  const groups = new Map<LegacyLayer, { layer: LegacyLayer; doc: Record<string, unknown> }[]>()
  for (const item of parsed) {
    const list = groups.get(item.layer) ?? []
    list.push(item)
    groups.set(item.layer, list)
  }
  const folded: { layer: LegacyLayer; doc: Record<string, unknown> }[] = []
  for (const layer of LAYER_ORDER) {
    const list = groups.get(layer)
    if (!list || list.length === 0) continue
    const ordered = orderExtends(layer, list, diagnostics)
    const doc = ordered.reduce<Record<string, unknown>>(
      (base, item) => deepMerge(base, item.doc) as Record<string, unknown>,
      {},
    )
    folded.push({ layer, doc })
  }
  return folded
}

function orderExtends(
  layer: LegacyLayer,
  list: { layer: LegacyLayer; doc: Record<string, unknown> }[],
  diagnostics: Diagnostic[],
): { layer: LegacyLayer; doc: Record<string, unknown> }[] {
  if (list.length === 1) return list
  const byName = new Map<string, { layer: LegacyLayer; doc: Record<string, unknown> }>()
  for (const item of list) {
    const name = stringField(item.doc, 'name')
    if (!name) {
      diagnostics.push({
        code: 'duplicate_declaration',
        path: '/name',
        message: `layer ${layer} has more than one document`,
      })
      return list
    }
    if (byName.has(name)) {
      diagnostics.push({
        code: 'duplicate_declaration',
        path: '/name',
        message: `layer ${layer} declares ${name} more than once`,
      })
    }
    byName.set(name, item)
  }
  const children = new Set<string>()
  for (const item of list) {
    const parent = item.doc.extends
    if (typeof parent === 'string' && byName.has(parent)) children.add(stringField(item.doc, 'name') ?? '')
  }
  const roots = [...byName.keys()].filter((name) => !children.has(name))
  if (roots.length !== 1) {
    diagnostics.push({
      code: 'duplicate_declaration',
      path: '/name',
      message: `layer ${layer} has more than one document`,
    })
    return list
  }
  const root = roots[0]
  if (!root) return list
  const chain = presetChain(root, byName, diagnostics)
  return chain.length > 0 ? chain : list
}

function applyProfileLayer(
  layer: { layer: LegacyLayer; doc: Record<string, unknown> },
  state: ProfileApply,
): void {
  const { doc } = layer
  markOrigin(state, '/name', layer.layer, doc)
  markOrigin(state, '/schemaVersion', layer.layer, doc)
  const name = stringField(doc, 'name')
  if (name) {
    if (!NAME_PATTERN.test(name)) {
      state.diagnostics.push({
        code: 'schema_invalid',
        path: '/name',
        message: 'profile name is not a legal identifier',
      })
    } else state.provider.identity.name = name
    state.effective.name = name
  }
  if (Object.hasOwn(doc, 'schemaVersion')) {
    const version = doc.schemaVersion
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
      state.diagnostics.push({
        code: 'schema_invalid',
        path: '/schemaVersion',
        message: 'legacy schemaVersion must be an integer greater than or equal to 1',
      })
    } else state.provider.identity.schemaVersion = version
    state.effective.schemaVersion = version
  }
  applyPackages(layer.layer, doc.packages, state)
  applyLimits(layer.layer, doc.limits, state)
  applyCeiling(layer.layer, doc, state)
  applyApprovals(layer.layer, doc.approvals, state)
  applyComputerUse(layer.layer, doc.computerUse, state)
  applyIsolation(layer.layer, doc.extensionIsolation, state)
  applyDirectories(layer.layer, doc, state)
  applyRoutes(layer.layer, doc.provider, state)
  copyPlain(layer.layer, doc, state)
  if (typeof doc.extends === 'string') {
    state.effective.extends = doc.extends
    state.origins.set('/extends', { layer: layer.layer, source: 'document' })
    state.diagnostics.push({
      code: 'manifest_digest_required',
      path: '/extends',
      message: 'profile extends is preserved and the parent digest is not issued here',
    })
  }
}

function markOrigin(
  state: ProfileApply,
  path: string,
  layer: LegacyLayer,
  doc: Record<string, unknown>,
): void {
  if (readPath(doc, path).present) state.origins.set(path, { layer, source: 'document' })
}

function applyPackages(layer: LegacyLayer, value: unknown, state: ProfileApply): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    state.diagnostics.push({
      code: 'schema_invalid',
      path: '/packages[]',
      message: 'packages must be an array',
    })
    return
  }
  const seen = new Set<string>()
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string') {
      state.diagnostics.push({
        code: 'schema_invalid',
        path: '/packages[]/id',
        message: 'package id is missing',
      })
      continue
    }
    if (seen.has(item.id)) {
      state.diagnostics.push({
        code: 'duplicate_declaration',
        path: '/packages[]/id',
        message: `package ${item.id} is listed twice in ${layer}`,
      })
      continue
    }
    seen.add(item.id)
    const prior = state.packages.get(item.id)
    const tombstone = item.tombstone === true
    const enabled = tombstone ? false : item.enabled !== false
    if (prior && (prior.enabled === false || prior.tombstone) && enabled) {
      state.diagnostics.push({
        code: 'disabled_package_revived',
        path: '/packages[]/enabled',
        message: `package ${item.id} is disabled and a weaker layer cannot enable it`,
      })
      continue
    }
    const next: PackageState = {
      id: item.id,
      enabled: prior && !enabled ? false : enabled,
      tombstone: prior?.tombstone === true || tombstone,
    }
    if (item.source !== undefined) next.source = item.source
    else if (prior?.source !== undefined) next.source = prior.source
    if (item.version !== undefined) next.version = item.version
    else if (prior?.version !== undefined) next.version = prior.version
    if (item.config !== undefined) next.config = item.config
    else if (prior?.config !== undefined) next.config = prior.config
    state.packages.set(item.id, next)
  }
  for (const path of [
    '/packages[]/id',
    '/packages[]/enabled',
    '/packages[]/tombstone',
    '/packages[]/source',
    '/packages[]/version',
    '/packages[]/config',
  ]) {
    if (readPath({ packages: value }, path).present) state.origins.set(path, { layer, source: 'document' })
  }
}

function applyLimits(layer: LegacyLayer, value: unknown, state: ProfileApply): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    state.diagnostics.push({ code: 'schema_invalid', path: '/limits', message: 'limits must be an object' })
    return
  }
  const kept: Record<string, unknown> = { ...(recordField(state.effective, 'limits') ?? {}) }
  for (const [key, limit] of Object.entries(value)) {
    const known = LEGACY_LIMITS[key]
    if (!known) {
      state.diagnostics.push({
        code: 'unknown_field',
        path: `/limits/${key}`,
        message: `unknown field /limits/${key}`,
      })
      continue
    }
    kept[key] = limit
    if (!known.placed) {
      state.provider.preserved = state.provider.preserved.filter((item) => item.path !== `/limits/${key}`)
      state.provider.preserved.push({ path: `/limits/${key}`, value: limit, reason: 'target_schema_missing' })
      if (
        !state.diagnostics.some(
          (item) => item.code === 'target_schema_missing' && item.path === `/limits/${key}`,
        )
      ) {
        state.diagnostics.push({
          code: 'target_schema_missing',
          path: `/limits/${key}`,
          message: `${key} has no field on the published assembly parameters`,
        })
      }
    }
    if (key === 'approval.park' && limit === 1) state.side.approvalPark = true
  }
  state.effective.limits = kept
  state.origins.set('/limits', { layer, source: 'document' })
  const placed: Record<string, unknown> = {}
  for (const [key, limit] of Object.entries(kept)) {
    if (LEGACY_LIMITS[key]?.placed && key !== 'approval.park') placed[key] = limit
  }
  const process = processLimits(placed)
  if (process) {
    state.provider.preserved = state.provider.preserved.filter((item) => item.reason !== 'process-limits')
    state.provider.preserved.push({ path: '/limits', value: process, reason: 'process-limits' })
  }
}

function processLimits(limits: Record<string, unknown>): Record<string, unknown> | undefined {
  const process: Record<string, unknown> = {}
  const mapping: Record<string, string> = {
    'daemon.max_workers': 'maxWorkers',
    'worker.idle_evict_ms': 'workerIdleEvictMs',
    'worker.startup_ms': 'workerStartupMs',
    'shutdown.grace_ms': 'shutdownGraceMs',
  }
  for (const [key, target] of Object.entries(mapping)) {
    if (limits[key] !== undefined) process[target] = limits[key]
  }
  return Object.keys(process).length > 0 ? process : undefined
}

function applyCeiling(layer: LegacyLayer, doc: Record<string, unknown>, state: ProfileApply): void {
  const policy = recordField(doc, 'policy')
  if (!policy || !Object.hasOwn(policy, 'capabilityCeiling')) return
  const next = policy.capabilityCeiling
  if (!Array.isArray(next) || next.some((item) => typeof item !== 'string')) {
    state.diagnostics.push({
      code: 'schema_invalid',
      path: '/policy/capabilityCeiling[]',
      message: 'capability ceiling must be an array of names',
    })
    return
  }
  if (state.ceiling !== undefined && next.some((item) => !state.ceiling?.includes(item))) {
    state.diagnostics.push({
      code: 'configuration_widens_authority',
      path: '/policy/capabilityCeiling[]',
      message: 'a weaker layer cannot add a capability outside the current ceiling',
    })
    return
  }
  state.setCeiling([...next])
  const current = recordField(state.effective, 'policy') ?? {}
  current.capabilityCeiling = [...next]
  state.effective.policy = current
  state.origins.set('/policy/capabilityCeiling[]', { layer, source: 'document' })
  if (policy.workspacePackages !== undefined) {
    current.workspacePackages = policy.workspacePackages
    state.origins.set('/policy/workspacePackages', { layer, source: 'document' })
  }
}

function applyApprovals(layer: LegacyLayer, value: unknown, state: ProfileApply): void {
  if (value === undefined) return
  if (!isRecord(value) || (value.mode !== 'off' && value.mode !== 'smart' && value.mode !== 'manual')) {
    state.diagnostics.push({
      code: 'schema_invalid',
      path: '/approvals/mode',
      message: 'approvals.mode is invalid',
    })
    return
  }
  const mode = value.mode
  if (layer === 'workspace' && mode === 'off') {
    state.diagnostics.push({
      code: 'configuration_widens_authority',
      path: '/approvals/mode',
      message: 'workspace approvals cannot be off',
    })
    return
  }
  const prior = state.approval ?? (layer === 'workspace' ? 'manual' : undefined)
  if (prior && APPROVAL_RANK[mode] < APPROVAL_RANK[prior]) {
    state.diagnostics.push({
      code: 'configuration_widens_authority',
      path: '/approvals/mode',
      message: 'a weaker layer cannot relax approvals.mode',
    })
    return
  }
  state.setApproval(mode)
  state.effective.approvals = { mode }
  state.origins.set('/approvals/mode', { layer, source: 'document' })
}

function applyComputerUse(layer: LegacyLayer, value: unknown, state: ProfileApply): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    state.diagnostics.push({
      code: 'schema_invalid',
      path: '/computerUse',
      message: 'computerUse must be an object',
    })
    return
  }
  if (state.computerUse && widensComputerUse(state.computerUse, value)) {
    state.diagnostics.push({
      code: 'configuration_widens_authority',
      path: '/computerUse',
      message: 'a weaker layer cannot enable computer use or grow its lists',
    })
    return
  }
  const next = {
    ...(state.computerUse ?? {}),
    ...structuredClone(value),
    capture: {
      ...(recordField(state.computerUse, 'capture') ?? {}),
      ...(recordField(value, 'capture') ?? {}),
    },
    retention: {
      ...(recordField(state.computerUse, 'retention') ?? {}),
      ...(recordField(value, 'retention') ?? {}),
    },
  }
  state.setComputerUse(next)
  state.effective.computerUse = next
  for (const path of legacyPaths('profile')) {
    if (path.startsWith('/computerUse/') && readPath({ computerUse: value }, path).present) {
      state.origins.set(path, { layer, source: 'document' })
    }
  }
}

function widensComputerUse(base: Record<string, unknown>, next: Record<string, unknown>): boolean {
  if (base.enabled === false && next.enabled === true) return true
  if (base.appAccess === 'allowlist' && next.appAccess === 'all') return true
  const baseCapture = recordField(base, 'capture') ?? {}
  const nextCapture = recordField(next, 'capture') ?? {}
  if (baseCapture.allowFullDesktop === false && nextCapture.allowFullDesktop === true) return true
  for (const key of CAPTURE_KEYS) {
    if (
      typeof nextCapture[key] === 'number' &&
      typeof baseCapture[key] === 'number' &&
      nextCapture[key] > baseCapture[key]
    ) {
      return true
    }
  }
  const baseRetention = recordField(base, 'retention') ?? {}
  const nextRetention = recordField(next, 'retention') ?? {}
  for (const key of ['maxRecentPerSession', 'ttlMs', 'gcIntervalMs', 'maxExtendedTtlMs', 'globalMaxBytes']) {
    if (
      typeof nextRetention[key] === 'number' &&
      typeof baseRetention[key] === 'number' &&
      nextRetention[key] > baseRetention[key]
    ) {
      return true
    }
  }
  if (Array.isArray(next.appAllowlist) && Array.isArray(base.appAllowlist)) {
    const prior = new Set(base.appAllowlist.map((item) => canonicalJson(item)))
    if (next.appAllowlist.some((item) => !prior.has(canonicalJson(item)))) return true
  }
  return false
}

function applyIsolation(layer: LegacyLayer, value: unknown, state: ProfileApply): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    state.diagnostics.push({
      code: 'schema_invalid',
      path: '/extensionIsolation',
      message: 'extensionIsolation must be an object',
    })
    return
  }
  const current = recordField(state.effective, 'extensionIsolation') ?? { extensions: {} }
  const extensions = { ...(recordField(current, 'extensions') ?? {}) }
  const incoming = recordField(value, 'extensions') ?? {}
  for (const [id, mode] of Object.entries(incoming)) {
    if (mode !== 'off' && mode !== 'preferred' && mode !== 'required') {
      state.diagnostics.push({
        code: 'schema_invalid',
        path: `/extensionIsolation/extensions/${id}`,
        message: 'extension isolation mode is invalid',
      })
      continue
    }
    const previous = extensions[id]
    if (
      (previous === 'off' || previous === 'preferred' || previous === 'required') &&
      ISOLATION_RANK[mode] < ISOLATION_RANK[previous]
    ) {
      state.diagnostics.push({
        code: 'configuration_widens_authority',
        path: '/extensionIsolation/extensions',
        message: `extension ${id} isolation cannot be relaxed by a weaker layer`,
      })
      continue
    }
    extensions[id] = mode
  }
  const next: Record<string, unknown> = { extensions }
  if (typeof value.backend === 'string') next.backend = value.backend
  else if (typeof current.backend === 'string') next.backend = current.backend
  state.effective.extensionIsolation = next
  state.origins.set('/extensionIsolation/extensions', { layer, source: 'document' })
  if (next.backend !== undefined)
    state.origins.set('/extensionIsolation/backend', { layer, source: 'document' })
}

function applyDirectories(layer: LegacyLayer, doc: Record<string, unknown>, state: ProfileApply): void {
  for (const key of ['dataDir', 'cacheDir'] as const) {
    if (!Object.hasOwn(doc, key)) continue
    const value = doc[key]
    if (typeof value !== 'string' || value === '') {
      state.diagnostics.push({ code: 'schema_invalid', path: `/${key}`, message: `${key} must be a path` })
      continue
    }
    const resolved = resolveDirectory(value, state.home)
    if (!resolved.ok) {
      state.diagnostics.push({ code: resolved.code, path: `/${key}`, message: resolved.message })
      continue
    }
    state.effective[key] = resolved.path
    state.provider.directories[key] = resolved.path
    state.origins.set(`/${key}`, { layer, source: 'document' })
  }
}

function resolveDirectory(
  value: string,
  home: string | undefined,
):
  | { ok: true; path: string }
  | { ok: false; code: 'home_unresolved' | 'path_not_absolute'; message: string } {
  if (value.startsWith('~')) {
    if (!home)
      return { ok: false, code: 'home_unresolved', message: 'a home-relative path needs the deployer home' }
    const rest = value === '~' ? '' : value.startsWith('~/') ? value.slice(2) : value.slice(1)
    return { ok: true, path: rest === '' ? home : join(home, rest) }
  }
  if (!isAbsolute(value)) {
    return home
      ? { ok: true, path: join(home, value) }
      : {
          ok: false,
          code: 'path_not_absolute',
          message: 'a relative directory is not given an absolute path',
        }
  }
  return { ok: true, path: value }
}

function applyRoutes(layer: LegacyLayer, value: unknown, state: ProfileApply): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    state.diagnostics.push({
      code: 'schema_invalid',
      path: '/provider',
      message: 'provider must be an object',
    })
    return
  }
  const routes = value.routes
  if (Array.isArray(routes)) {
    for (const route of routes) {
      const name = isRecord(route) && typeof route.route === 'string' ? route.route : undefined
      if (!name) continue
      if (state.routes.has(name)) {
        state.diagnostics.push({
          code: 'duplicate_declaration',
          path: '/provider/routes[]/route',
          message: `route ${name} is declared more than once`,
        })
        continue
      }
      state.routes.add(name)
    }
  }
  state.effective.provider = deepMerge(state.effective.provider, value)
  state.provider.preserved.push({ path: '/provider', value, reason: 'manifest_digest_required' })
  state.diagnostics.push({
    code: 'manifest_digest_required',
    path: '/provider',
    message: 'provider configuration is preserved until its package digest exists',
  })
  for (const path of legacyPaths('profile')) {
    if (path.startsWith('/provider/') && readPath({ provider: value }, path).present) {
      state.origins.set(path, { layer, source: 'document' })
    }
  }
}

const PLAIN_KEYS = [
  'adapters',
  'presets',
  'seams',
  'reconcile',
  'commandHooks',
  'transports',
  'version',
  'packagesDeny',
] as const

function copyPlain(layer: LegacyLayer, doc: Record<string, unknown>, state: ProfileApply): void {
  for (const key of PLAIN_KEYS) {
    if (!Object.hasOwn(doc, key)) continue
    state.effective[key] = deepMerge(state.effective[key], doc[key])
    const root = `/${key}`
    for (const path of legacyPaths(layer === 'managed' ? 'managed' : 'profile')) {
      if (
        (path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}[]`)) &&
        readPath({ [key]: doc[key] }, path).present
      ) {
        state.origins.set(path, { layer, source: 'document' })
      }
    }
    if (key === 'adapters' || key === 'presets' || key === 'seams') {
      state.provider.preserved.push({ path: root, value: doc[key], reason: 'manifest_digest_required' })
      state.diagnostics.push({
        code: 'manifest_digest_required',
        path: root,
        message: `${key} is preserved until its digest exists`,
      })
    }
  }
  materializePolicy(state)
  materializeAssembly(state)
  materializeTransports(state)
}

function materializePolicy(state: ProfileApply): void {
  const approvals = recordField(state.effective, 'approvals')
  const computerUse = recordField(state.effective, 'computerUse')
  if (!approvals && !computerUse) return
  const filled = fillComputerUse(computerUse ?? {}, state)
  const { retention: filledRetention, ...computerUseOnly } = filled
  const policy = { approvals: approvals ?? { mode: 'manual' }, computerUse: computerUseOnly }
  if (!approvals) {
    state.origins.set('/approvals/mode', { layer: 'user', source: 'specified-default' })
    state.effective.approvals = { mode: 'manual' }
  }
  const validated = validateRuntime('DefaultPolicyParameters', policy)
  if (!validated.ok) {
    for (const error of validated.errors) {
      state.diagnostics.push({
        code: 'schema_invalid',
        path: error.path || '/policy',
        message: `policy parameters failed validation (${error.code})`,
      })
    }
    return
  }
  state.provider.policy = validated.value
  const retention = isRecord(filledRetention) ? filledRetention : undefined
  if (retention && Object.keys(retention).length > 0) {
    const checked = validateRuntime('ComputerUseRetentionParameters', retention)
    state.provider.retention = checked.ok ? checked.value : null
    if (!checked.ok) {
      state.diagnostics.push({
        code: 'schema_invalid',
        path: '/computerUse/retention',
        message: 'computer-use retention failed validation',
      })
    }
  }
}

function fillComputerUse(value: Record<string, unknown>, state: ProfileApply): Record<string, unknown> {
  const capture = { ...DEFAULT_COMPUTER_USE.capture, ...(recordField(value, 'capture') ?? {}) }
  const retention = { ...DEFAULT_COMPUTER_USE.retention, ...(recordField(value, 'retention') ?? {}) }
  const filled = {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_COMPUTER_USE.enabled,
    appAccess:
      value.appAccess === 'allowlist' || value.appAccess === 'all'
        ? value.appAccess
        : DEFAULT_COMPUTER_USE.appAccess,
    appAllowlist: Array.isArray(value.appAllowlist) ? value.appAllowlist : [],
    capture,
    retention,
  }
  rememberDefault(state, '/computerUse/enabled', value, 'enabled')
  rememberDefault(state, '/computerUse/appAccess', value, 'appAccess')
  if (!Array.isArray(value.appAllowlist)) {
    state.origins.set('/computerUse/appAllowlist[]/platform', { layer: 'user', source: 'specified-default' })
  }
  return filled
}

function rememberDefault(
  state: ProfileApply,
  path: string,
  source: Record<string, unknown>,
  key: string,
): void {
  if (!Object.hasOwn(source, key) && !state.origins.has(path)) {
    state.origins.set(path, { layer: 'user', source: 'specified-default' })
  }
}

function materializeAssembly(state: ProfileApply): void {
  const process = state.provider.preserved.find(
    (item) => item.path === '/limits' && item.reason === 'process-limits',
  )
  const reconcile = state.effective.reconcile
  const workspacePackages = recordField(state.effective, 'policy')?.workspacePackages
  const wanted =
    process ||
    reconcile !== undefined ||
    workspacePackages !== undefined ||
    state.effective.extensionIsolation ||
    state.effective.commandHooks
  if (!wanted) return
  const body = isRecord(process?.value) ? process.value : undefined
  const complete =
    body?.maxWorkers !== undefined &&
    body.workerIdleEvictMs !== undefined &&
    body.workerStartupMs !== undefined &&
    body.shutdownGraceMs !== undefined &&
    reconcile !== undefined &&
    workspacePackages !== undefined
  if (!complete) {
    if (!state.diagnostics.some((item) => item.code === 'fragment_incomplete' && item.path === '/limits')) {
      state.diagnostics.push({
        code: 'fragment_incomplete',
        path: '/limits',
        message:
          'assembly parameters are preserved until reconcile, workspace packages, and process limits are all present',
      })
    }
    return
  }
  const assembly: Record<string, unknown> = {
    reconcile,
    workspacePackages,
    process: body,
  }
  if (state.effective.extensionIsolation) assembly.extensionIsolation = state.effective.extensionIsolation
  if (state.effective.commandHooks) assembly.commandHooks = state.effective.commandHooks
  const validated = validateRuntime('DefaultAssemblyParameters', assembly)
  if (!validated.ok) {
    state.diagnostics.push({
      code: 'schema_invalid',
      path: '/limits',
      message: 'assembly parameters failed validation',
    })
    return
  }
  state.provider.assembly = validated.value
}

function materializeTransports(state: ProfileApply): void {
  if (!Object.hasOwn(state.effective, 'transports')) return
  const validated = validateRuntime('DefaultTransportParameters', { transports: state.effective.transports })
  if (!validated.ok) {
    state.diagnostics.push({
      code: 'schema_invalid',
      path: '/transports[]',
      message: 'transport parameters failed validation',
    })
    return
  }
  state.provider.transports = validated.value
}

function profileRow(
  path: string,
  effective: Record<string, unknown>,
  origins: Map<string, { layer: LegacyLayer; source: FieldSource }>,
  kind: LegacyKind = 'profile',
): FieldRow {
  const found = readPath(effective, path)
  const origin = origins.get(path)
  const field = classifyLegacyField(kind, path)
  const redacted = found.present && field.secret && secretMaterial(found.value)
  return {
    kind,
    path,
    present: found.present,
    source: found.present ? (origin?.source ?? 'document') : 'absent',
    ...(origin && found.present ? { layer: origin.layer } : {}),
    ...(found.present && !redacted ? { value: found.value } : {}),
    target: field.target,
    unit: field.unit,
    boundary: field.boundary,
    disposition: field.disposition,
    placed: field.placed,
    notes: redacted ? ['redacted'] : [],
  }
}

function rowFor(
  kind: LegacyKind,
  path: string,
  effective: Record<string, unknown>,
  child: Record<string, unknown>,
  mergedRaw: Record<string, unknown>,
  layer: LegacyLayer | undefined,
  notes: string[] = [],
): FieldRow {
  const field = classifyLegacyField(kind, path)
  const value = path === '/model/retry/backoff_ms' ? readPath(mergedRaw, path) : readPath(effective, path)
  const onChild = sourcePresent(child, path)
  const onRaw = sourcePresent(mergedRaw, path)
  const source: FieldSource = !value.present
    ? 'absent'
    : onChild
      ? 'document'
      : onRaw
        ? 'parent'
        : 'specified-default'
  const redacted = value.present && field.secret && secretMaterial(value.value)
  return {
    kind,
    path,
    present: value.present,
    source,
    ...(layer && value.present ? { layer } : {}),
    ...(value.present && !redacted ? { value: value.value } : {}),
    target: field.target,
    unit: field.unit,
    boundary: field.boundary,
    disposition: field.disposition,
    placed: field.placed && field.disposition !== 'blocked',
    notes: redacted ? [...notes, 'redacted'] : notes,
  }
}

function sourcePresent(doc: Record<string, unknown>, path: string): boolean {
  if (readPath(doc, path).present) return true
  if (path === '/model/retry/base_delay_ms' && readPath(doc, '/model/retry/backoff_ms').present) return true
  const route = /^\/model\/route\/([^/]+)\/(route|model)$/.exec(path)
  const slot = route?.[1]
  const leaf = route?.[2]
  const model = recordField(doc, 'model')
  const table = model ? recordField(model, 'route') : undefined
  if (!slot || !table || !Object.hasOwn(table, slot)) return false
  const target = table[slot]
  if (leaf === 'route' && typeof target === 'string') return true
  if (leaf === 'model' && model) {
    const pins = recordField(model, 'id')
    return typeof pins?.[slot] === 'string' && pins[slot] !== 'default'
  }
  return false
}

function collectUnknown(kind: LegacyKind, doc: Record<string, unknown>, diagnostics: Diagnostic[]): void {
  const found: string[] = []
  concreteLeaves(doc, '', found)
  const open = new Set(legacyPaths(kind).filter((path) => classifyLegacyField(kind, path).open))
  for (const pointer of found) {
    const normalized = pointer.replace(/\/\d+(?=\/|$)/g, '[]').replace(/\[\d+\]/g, '[]')
    if (isKnownPointer(kind, normalized, open)) continue
    diagnostics.push({ code: 'unknown_field', path: pointer, message: `unknown field ${pointer}` })
  }
}

function isKnownPointer(kind: LegacyKind, path: string, open: Set<string>): boolean {
  if (path === '/model/id' || path.startsWith('/model/id/')) return true
  if (isLegacyPath(kind, path)) return true
  if (kind === 'managed' && isLegacyPath('profile', path) && layerAllows('managed', path)) return true
  for (const candidate of legacyPaths(kind)) {
    if (candidate.startsWith(`${path}/`) || candidate.startsWith(`${path}[]`)) return true
  }
  for (const candidate of open) {
    if (path.startsWith(`${candidate}/`)) return true
  }
  return false
}

function collectSecrets(kind: LegacyKind, doc: Record<string, unknown>, diagnostics: Diagnostic[]): void {
  for (const path of legacyPaths(kind)) {
    const field = classifyLegacyField(kind, path)
    if (!field.secret) continue
    const found = readPath(doc, path)
    if (!found.present) continue
    if (secretMaterial(found.value)) {
      diagnostics.push({
        code: 'secret_material',
        path,
        message: 'a secret field must be a secret:// reference',
      })
    }
  }
}

function secretMaterial(value: unknown): boolean {
  if (typeof value === 'string') return !SECRET_REFERENCE.test(value)
  if (Array.isArray(value)) return value.some((item) => secretMaterial(item))
  if (isRecord(value)) return Object.values(value).some((item) => secretMaterial(item))
  return value !== undefined
}

function collectForbidden(layer: LegacyLayer, doc: Record<string, unknown>, diagnostics: Diagnostic[]): void {
  const kind: LegacyKind = layer === 'managed' ? 'managed' : 'profile'
  for (const path of legacyPaths(kind === 'managed' ? 'profile' : 'profile')) {
    if (!readPath(doc, path).present) continue
    if (!layerAllows(layer, path)) {
      diagnostics.push({
        code: 'layer_field_forbidden',
        path,
        message: `${layer} cannot set ${path}`,
      })
    }
  }
  if (layer === 'managed') {
    for (const path of legacyPaths('managed')) {
      if (!isLegacyPath('profile', path) && readPath(doc, path).present && !layerAllows(layer, path)) {
        diagnostics.push({ code: 'layer_field_forbidden', path, message: `${layer} cannot set ${path}` })
      }
    }
  }
}

function parseDocument(
  document: unknown,
  diagnostics: Diagnostic[],
  path: string,
): Record<string, unknown> | undefined {
  let value = document
  if (typeof document === 'string') {
    try {
      value = parseYaml(document)
    } catch {
      diagnostics.push({ code: 'schema_invalid', path, message: 'document is not valid YAML' })
      return undefined
    }
  }
  if (!isRecord(value)) {
    diagnostics.push({ code: 'schema_invalid', path, message: 'document must be an object' })
    return undefined
  }
  try {
    return structuredClone(value)
  } catch {
    diagnostics.push({ code: 'schema_invalid', path, message: 'document is not clonable' })
    return undefined
  }
}

function chainItems(
  seen: readonly string[],
  byName: Map<string, { layer: LegacyLayer; doc: Record<string, unknown> }>,
): { layer: LegacyLayer; doc: Record<string, unknown> }[] {
  const items: { layer: LegacyLayer; doc: Record<string, unknown> }[] = []
  for (const name of seen) {
    const found = byName.get(name)
    if (found) items.push(found)
  }
  return items.reverse()
}

function concreteLeaves(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index++) concreteLeaves(node[index], `${path}/${index}`, out)
    return
  }
  if (isRecord(node)) {
    const keys = Object.keys(node)
    if (keys.length === 0 && path) out.push(path)
    for (const key of keys) concreteLeaves(node[key], `${path}/${key}`, out)
    return
  }
  if (path) out.push(path)
}

function readPath(root: unknown, path: string): { present: boolean; value: unknown } {
  const parts = path.split('/').filter(Boolean)
  const found: unknown[] = []
  const walk = (node: unknown, index: number): void => {
    if (index === parts.length) {
      found.push(node)
      return
    }
    const part = parts[index]
    if (!part || !isRecord(node)) return
    const array = part.endsWith('[]')
    const key = array ? part.slice(0, -2) : part
    if (!Object.hasOwn(node, key)) return
    const next = node[key]
    if (!array) {
      walk(next, index + 1)
      return
    }
    if (!Array.isArray(next)) return
    if (index === parts.length - 1) {
      found.push(next)
      return
    }
    for (const item of next) walk(item, index + 1)
  }
  walk(root, 0)
  if (found.length === 0) return { present: false, value: undefined }
  const nested = parts.some((part, index) => part.endsWith('[]') && index < parts.length - 1)
  return { present: true, value: nested ? found : found[0] }
}

function assignPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('/').filter(Boolean)
  let cursor = root
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index]
    if (!part) return
    const key = part.endsWith('[]') ? part.slice(0, -2) : part
    const next = cursor[key]
    if (!isRecord(next)) {
      const created: Record<string, unknown> = {}
      cursor[key] = created
      cursor = created
    } else cursor = next
  }
  const last = parts[parts.length - 1]
  if (!last) return
  cursor[last.endsWith('[]') ? last.slice(0, -2) : last] = value
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (Array.isArray(over)) return structuredClone(over)
  if (isRecord(over) && isRecord(base)) {
    const out: Record<string, unknown> = structuredClone(base)
    for (const [key, value] of Object.entries(over)) out[key] = deepMerge(out[key], value)
    return out
  }
  return structuredClone(over)
}

function stable(value: unknown): string {
  return canonicalJson(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const next = value[key]
  return isRecord(next) ? next : undefined
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const next = value[key]
  return typeof next === 'string' ? next : undefined
}

export function refusalCodes(): ReadonlySet<string> {
  return REFUSAL
}

export function sessionAssign(root: Record<string, unknown>, path: string, value: unknown): void {
  assignPath(root, path, value)
}

export { classifyLegacyField, MAX_STEPS_FEATURE }
