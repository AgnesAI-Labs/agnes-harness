import type { PresetView } from '@agnes/core'
import type { ModelRecord, RouteTable, RouteTarget, SlotName } from '@agnes/protocol'
import { SLOT_NAMES } from '@agnes/protocol'
import { HostError } from '../errors.js'
import type { ResolvedProfile, RouteDecl } from '../profile/types.js'

// The literal core's presetDefaults() writes when a deployment has said nothing about routing. It
// is reserved as a route name (profile/templates.ts) so that "not configured" and "configured as
// default" can never be the same string.
const SENTINEL = 'default'
const SLOTS = new Set<string>(SLOT_NAMES)

// Every refusal here names its reason twice on purpose: once in the message an operator reads, once
// in `detail.reason`, which is what a test and a log filter match on.
function bad(reason: string, why: string, detail: Record<string, unknown> = {}): never {
  throw new HostError('E_PRESET_UNRESOLVED', `${reason}: ${why}`, { detail: { reason, ...detail } })
}

function pickModel(decl: RouteDecl, slot: string, preset: string): string {
  const models = decl.models ?? []
  const m = models.find((x) => x.slot === slot) ?? models[0]
  if (!m) bad('no-models', `route ${decl.route} declares no models`, { slot, route: decl.route, preset })
  return m.id
}

/**
 * Turns the preset's slot-to-route-name map into the slot-to-target map ai actually needs. Two
 * things are resolved here and nowhere else: the literal `default`, and the model id, which the
 * preset carries only when a deployment pinned one.
 *
 * Every failure is a refusal at assembly. The alternative - handing an unresolved name to ai - does
 * not fail loudly on the other side: the slot resolver reads the route table, the registry returns
 * undefined on a miss, and the provider facade encodes that as an in-stream
 * `{ type: 'error', code: 'NO_ADAPTER' }` event, so a deployment that was never configured boots
 * green and degrades in the middle of the operator's first turn.
 */
export function materializeRoutes(preset: PresetView, profile: ResolvedProfile): RouteTable {
  const declared = profile.provider.routes ?? []
  const named = preset.name
  if (declared.length === 0) bad('no-routes', 'the profile declares no provider.routes', { preset: named })
  const byName = new Map(declared.map((r) => [r.route, r] as const))
  const out: Partial<Record<SlotName, RouteTarget>> = {}
  // A pin with no route beside it is the sentinel leak from the other direction: core reads
  // `route[slot] ?? 'default'` and returns the pinned id under route `default`, so the request would
  // go to a route no adapter serves while the header named a model nobody asked for.
  for (const slot of Object.keys(preset.model.id))
    if (!(slot in preset.model.route))
      bad('pin-without-route', `model.id.${slot} pins a slot with no route`, { slot, preset: named })
  for (const [slot, name] of Object.entries(preset.model.route)) {
    if (!SLOTS.has(slot)) bad('unknown-slot', `${slot} is not a protocol SlotName`, { slot, preset: named })
    const decl = name === SENTINEL ? declared[0] : byName.get(name)
    if (!decl)
      bad('unknown-route', `the profile declares no route ${name}`, { slot, route: name, preset: named })
    // Ruling C-26: `preset.model.id` is validated by nothing and core hands a pin straight to the
    // wire. A pin is honoured, but only against a catalogue that offers it. A route that declares no
    // catalogue here is one the registry fills in, and verifyRoutes checks it after the seal.
    const pinned = preset.model.id[slot]
    const models = decl.models ?? []
    if (pinned !== undefined && models.length > 0 && !models.some((m) => m.id === pinned))
      bad('model-undeclared', `route ${decl.route} does not declare model ${pinned}`, { slot, model: pinned })
    out[slot as SlotName] = { route: decl.route, model: pinned ?? pickModel(decl, slot, named) }
  }
  const primary = out.primary
  if (!primary) bad('no-primary', 'the preset names no primary slot', { preset: named })
  return { ...out, primary }
}

/**
 * Writes the resolved table back into the view the session runs on. Without this the table ai reads
 * and the header core writes disagree: core's resolveModel reads `preset.model.route[slot]`, so a
 * view still carrying `default` records a request against a route called `default` and - through the
 * `model: id ?? route` fallback - a model of the same name, while the request itself went wherever
 * the table said. After the pin, resolveModel returns the table's own answer and never reaches that
 * fallback.
 *
 * The header still records no route of its own, and that is protocol's to change rather than host's:
 * RequestHeader in session-v1.json has no `route` property, is additionalProperties:false, and spells
 * `model` as a flat string, so the field is absent and not null. core carries the route as far as
 * DeriveInput.model.route and drops it. Host's obligation ends at making the value core does record
 * the resolved one, which is what this function is for.
 */
export function pinPresetRoutes(preset: PresetView, routes: RouteTable): PresetView {
  const entries = Object.entries(routes) as Array<[string, RouteTarget]>
  return {
    ...preset,
    model: {
      ...preset.model,
      route: Object.fromEntries(entries.map(([slot, t]) => [slot, t.route])),
      id: Object.fromEntries(entries.map(([slot, t]) => [slot, t.model])),
    },
  }
}

/**
 * Verifies a materialized table against the registry ai actually sealed. This is the second half of
 * failing loudly: materializeRoutes reasons about what the profile declared, this reasons about what
 * the adapters accepted. Both projections are total - routes() and models() return arrays, unlike
 * lookup()'s undefined - so a miss here is a thrown refusal rather than a mid-turn event.
 */
export function verifyRoutes(
  routes: RouteTable,
  registry: { routes(): { route: string }[]; models(): ModelRecord[] },
): void {
  const known = new Set(registry.routes().map((r) => r.route))
  // Route and id together: a model id that exists on another route is not the model this slot
  // resolved to, and ai matches on the record's own `route` field for exactly that reason. The key
  // is JSON rather than a joined string so that no separator has to be assumed absent from either
  // half - a model id has no character class in the schema at all.
  const pair = (route: string, model: string): string => JSON.stringify([route, model])
  const offered = new Set(registry.models().map((m) => pair(m.route, m.id)))
  for (const [slot, t] of Object.entries(routes) as Array<[string, RouteTarget]>) {
    if (!known.has(t.route))
      bad('route-unserved', `the sealed registry does not serve route ${t.route}`, { slot, route: t.route })
    if (!offered.has(pair(t.route, t.model)))
      bad('model-unserved', `the sealed registry does not offer ${t.route}/${t.model}`, { slot, ...t })
  }
}

// SECURITY-FINDINGS section 4, the item marked as owed by host and not closed. On a standard
// bedrock hostname an AWS_REGION in the environment is enough to make the SDK stop honouring
// config.endpoint and start reading AWS_ENDPOINT_URL_BEDROCK_RUNTIME instead - and AWS_REGION is
// present by default on EC2, ECS, Lambda and EKS. `ai` cannot close this from inside the package:
// passing `region` is itself what unpins the endpoint. host owns the process environment, so it is
// closed here, immediately before a credential is bound to an adapter.
//
// The rule: the destination comes from the Profile, never from the environment. Every variable that
// can name or move a destination is removed; a bedrock route that needs a region declares it in
// `compat.region` and host re-exports exactly that. Removing the credential-file variables fails
// closed (an auth error) rather than open, and is correct anyway - host resolves credentials
// through `secret://`, not through ~/.aws.
const AWS_DESTINATION_ENV = [
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
  'AWS_ENDPOINT_URL',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_USE_FIPS_ENDPOINT',
  'AWS_USE_DUALSTACK_ENDPOINT',
] as const

// The api name a bedrock route actually declares. It is not `bedrock`: the wire layer registers its
// implementations under the protocol names, and a route saying `bedrock` cannot stream at all - it
// raises "No API provider registered" on the first request. A predicate written against the short
// name matches nothing on a real deployment, so the region a bedrock route declared is deleted and
// never given back. The tests below drive this constant through the wire layer for that reason.
export const BEDROCK_API = 'bedrock-converse-stream'

export function sweepAwsDestination(
  env: NodeJS.ProcessEnv,
  profile: ResolvedProfile,
): { removed: string[]; set: Record<string, string> } {
  const removed: string[] = AWS_DESTINATION_ENV.filter((k) => env[k] !== undefined)
  for (const k of removed) delete env[k]
  // The single strongest lever: it makes the SDK ignore every configured endpoint URL, including
  // the ones that arrive through ~/.aws/config on the default path, which no sweep of the
  // environment can reach.
  const set: Record<string, string> = { AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true' }
  const regions = new Set(
    (profile.provider.routes ?? [])
      .filter((r) => r.api === BEDROCK_API)
      .map((r) => (r.compat as { region?: unknown } | undefined)?.region)
      .filter((r): r is string => typeof r === 'string'),
  )
  // One process, one AWS_REGION. Two bedrock routes asking for different ones cannot both be served,
  // and taking whichever was declared first would send part of the traffic somewhere nobody chose.
  if (regions.size > 1)
    throw new HostError('E_PRESET_UNRESOLVED', 'bedrock routes declare more than one compat.region', {
      detail: { reason: 'bedrock-region-conflict', regions: [...regions].sort() },
    })
  const region = [...regions][0]
  if (region !== undefined) set.AWS_REGION = region
  Object.assign(env, set)
  return { removed, set }
}
