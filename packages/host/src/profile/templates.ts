import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SEAM_NAMES } from '@agnes/core'
import { parse } from 'yaml'
import { HostError, type Layer } from '../errors.js'
import type { RouteDecl, RuntimeProfileManifest } from './types.js'

export const TEMPLATE_NAMES = ['local-dev', 'enterprise'] as const
export const BUILTIN_PACKAGES = [
  '@agnes/base',
  '@agnes/code',
  '@agnes/enterprise',
  '@agnes/connector-db',
  '@agnes/connector-kb',
  '@agnes/ai',
] as const

// `default` is the unresolved sentinel core's presetDefaults() writes into model.route, and the one
// the assembly layer substitutes a real route for. A profile that declares a route actually named
// `default` would make "not configured" and "configured as default" the same string, so the name is
// refused here even though the protocol route pattern admits it.
export const RESERVED_ROUTE_NAMES = ['default'] as const

const TOP_LEVEL_KEYS = new Set([
  'name',
  'schemaVersion',
  'extends',
  'packages',
  'seams',
  'provider',
  'adapters',
  'transports',
  'dataDir',
  'cacheDir',
  'limits',
  'presets',
  'policy',
  'reconcile',
  'approvals',
  'computerUse',
  'extensionIsolation',
])

export function assertNoReservedRouteName(routes: RouteDecl[] | undefined, layer: Layer): void {
  for (const r of routes ?? [])
    if ((RESERVED_ROUTE_NAMES as readonly string[]).includes(r.route))
      throw new HostError(
        'E_PRESET_UNRESOLVED',
        `route name ${r.route} is reserved as the unresolved sentinel`,
        { source: { layer }, detail: { route: r.route, reason: 'reserved-route-name' } },
      )
}

/**
 * The shape check for a template. It is deliberately narrow: templates are release artefacts, so a
 * malformed one is a build error, not a user error. It is replaced wholesale by the protocol
 * manifest validator once that ships, and deleted in the same change — there is no second validator
 * to keep in sync.
 */
export function checkTemplateShape(doc: unknown, name: string): asserts doc is RuntimeProfileManifest {
  const bad = (why: string): never => {
    throw new Error(`template invalid: ${name}: ${why}`)
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) bad('not an object')
  const m = doc as Record<string, unknown>
  for (const k of Object.keys(m)) if (!TOP_LEVEL_KEYS.has(k)) bad(`unknown top-level key ${k}`)
  if (typeof m.name !== 'string' || m.name !== name) bad('name must equal the file name')
  if (m.schemaVersion !== 1) bad('schemaVersion must be 1')
  const seams = m.seams as Record<string, unknown> | undefined
  for (const seam of SEAM_NAMES)
    if (typeof seams?.[seam] !== 'string') bad(`seams.${seam} must name a package`)
  if (typeof (m.provider as { package?: unknown } | undefined)?.package !== 'string')
    bad('provider.package is required')
  const presets = m.presets as { default?: unknown; allowed?: unknown } | undefined
  if (typeof presets?.default !== 'string' || !Array.isArray(presets.allowed))
    bad('presets.default and presets.allowed are required')
  const allowed = presets?.allowed as unknown[]
  if (!allowed.includes(presets?.default)) bad('presets.default must be in presets.allowed')
  const approvals = m.approvals as { mode?: unknown } | undefined
  if (
    approvals !== undefined &&
    (typeof approvals !== 'object' ||
      approvals === null ||
      !['manual', 'smart', 'off'].includes(String(approvals.mode)) ||
      Object.keys(approvals).some((key) => key !== 'mode'))
  )
    bad('approvals must contain only mode manual, smart, or off')
  const computerUse = m.computerUse as
    | {
        enabled?: unknown
        appAccess?: unknown
        appAllowlist?: unknown
        capture?: unknown
        retention?: unknown
      }
    | undefined
  if (
    computerUse === undefined ||
    typeof computerUse !== 'object' ||
    computerUse === null ||
    computerUse.enabled !== (name === 'local-dev') ||
    computerUse.appAccess !== (name === 'local-dev' ? 'all' : 'allowlist') ||
    !Array.isArray(computerUse.appAllowlist) ||
    computerUse.appAllowlist.length !== 0 ||
    typeof computerUse.capture !== 'object' ||
    computerUse.capture === null ||
    typeof computerUse.retention !== 'object' ||
    computerUse.retention === null
  )
    bad(
      'computerUse must declare the reviewed local automatic or enterprise disabled defaults with an empty appAllowlist',
    )
  const reconcile = m.reconcile as
    | { point?: unknown; maxWaitMs?: unknown; [key: string]: unknown }
    | undefined
  if (reconcile !== undefined) {
    if (typeof reconcile !== 'object' || reconcile === null) bad('reconcile must be an object')
    if (!['immediate', 'turn', 'step'].includes(String(reconcile.point)))
      bad('reconcile.point must be immediate, turn, or step')
    if (Object.keys(reconcile).some((key) => key !== 'point' && key !== 'maxWaitMs'))
      bad('reconcile contains an unknown key')
    if (
      reconcile.maxWaitMs !== undefined &&
      (!Number.isInteger(reconcile.maxWaitMs) || Number(reconcile.maxWaitMs) < 0)
    )
      bad('reconcile.maxWaitMs must be a non-negative integer')
    if (reconcile.point === 'immediate' && reconcile.maxWaitMs !== undefined)
      bad('reconcile.maxWaitMs only applies to turn or step')
  }
}

const templatesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates')

/** Replaced with the reviewed template assets by the CLI SEA build. */
declare const AGNES_PROFILE_TEMPLATE_TEXTS: Readonly<Record<string, string>> | undefined

export function loadTemplate(name: string): RuntimeProfileManifest {
  if (!(TEMPLATE_NAMES as readonly string[]).includes(name))
    throw new HostError('E_DEP_MISSING', `no builtin template ${name}`, {
      source: { layer: 'builtin' },
      detail: { name },
    })
  const text =
    typeof AGNES_PROFILE_TEMPLATE_TEXTS === 'undefined'
      ? readFileSync(join(templatesDir, `${name}.yaml`), 'utf8')
      : AGNES_PROFILE_TEMPLATE_TEXTS[name]
  if (text === undefined) throw new HostError('E_DEP_MISSING', `no bundled template ${name}`)
  const doc = parse(text) as unknown
  checkTemplateShape(doc, name)
  assertNoReservedRouteName(doc.provider?.routes, 'builtin')
  return doc
}
