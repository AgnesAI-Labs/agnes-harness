import { type PresetView, readPreset } from '@agnes/core'
import { HostError } from '../errors.js'
import type { PresetDoc } from './types.js'
import { validatedPresetViewInput } from './validate.js'

const TIERS = new Set([0, 1, 2])

/**
 * The merged preset document, read into the view core's step machine consumes. The reading itself
 * is core's readPreset — one implementation of the snake_case-to-camelCase mapping, in the package
 * that owns PresetView. This wrapper adds only what belongs to the host: the document-level
 * refusals, and the one Profile limit that reaches a session as a preset knob.
 */
export function toPresetView(
  doc: PresetDoc,
  opts: { limits?: Record<string, number>; park?: unknown } = {},
): PresetView {
  const approval = (doc.approval ?? {}) as Record<string, unknown>
  // core types onTimeout as the single member 'rejected' and reads it from nowhere: a timed-out
  // approval is a rejection, full stop. A document that says otherwise is refused rather than
  // accepted-and-ignored, which is how an operator ends up believing a knob is in effect.
  if (approval.on_timeout !== undefined && approval.on_timeout !== 'rejected')
    throw new HostError(
      'E_PRESET_UNSUPPORTED',
      `preset ${doc.name}: approval.on_timeout may only be "rejected"`,
      { detail: { capability: 'approval.on_timeout', source: doc.name, value: approval.on_timeout } },
    )
  // Zero is not "no timeout", which is what a recipe writing it means by it. It reaches the view as
  // approval.timeoutMs = 0 and every approval times out at once - and a timed-out approval is a
  // rejection, so the knob that reads as "wait forever" refuses everything instead. Refused rather
  // than accepted-and-inverted; a recipe that wants no deadline omits the key.
  const timeout = approval.timeout_ms
  if (timeout !== undefined && !(typeof timeout === 'number' && Number.isInteger(timeout) && timeout >= 1))
    throw new HostError(
      'E_PRESET_UNSUPPORTED',
      `preset ${doc.name}: approval.timeout_ms must be a positive whole number of milliseconds`,
      { detail: { capability: 'approval.timeout_ms', source: doc.name, value: timeout } },
    )
  const tier = ((doc.verifier ?? {}) as Record<string, unknown>).default_tier
  if (tier !== undefined && !(typeof tier === 'number' && TIERS.has(tier)))
    throw new HostError(
      'E_PRESET_UNSUPPORTED',
      `preset ${doc.name}: verifier.default_tier must be 0, 1 or 2`,
      {
        detail: { capability: 'verifier.default_tier', source: doc.name, value: tier },
      },
    )

  const view = readRoutedPreset(validatedPresetViewInput(doc))
  // ERRATA B20: `--park` may not write a preset field through the flags layer, so cli hands it down
  // as a Profile limit and the conversion to a session knob happens here.
  if (opts.park === 1 || opts.limits?.['approval.park'] === 1)
    return { ...view, approval: { ...view.approval, onUnavailable: 'park' } }
  return view
}

/**
 * A slot names a route and, optionally, the model that route is asked to run. A recipe writes that
 * as one object per slot; the view core reads carries the two apart, as `model.route` and
 * `model.id`. Splitting them is host's job, and until now nobody did it: a document written in the
 * object form reached materializeRoutes with an object where a route name belonged and the host
 * refused to assemble at all, naming a route called `[object Object]`.
 *
 * `default` on either field is the unconfigured sentinel, not a value. As a route name the assembly
 * resolves it against the deployment's own adapter list; as a model id it means "the route's own
 * record decides", so it is dropped rather than written down as a pin - a pin the route never
 * declared is refused at assembly, which would make the sentinel unusable in the half of the pair it
 * was written for.
 *
 * The bare string form stays exactly as it was: it is what every hand-written preset in the tests
 * and every fixture uses, and it means the route alone.
 */
const SENTINEL = 'default'
function readRoutedPreset(doc: PresetDoc): PresetView {
  const declared = ((doc.model ?? {}) as Record<string, unknown>).route
  if (declared === undefined || declared === null || typeof declared !== 'object')
    return readPreset(doc, doc.name)
  const route: Record<string, string> = {}
  const id: Record<string, string> = {}
  for (const [slot, target] of Object.entries(declared as Record<string, unknown>)) {
    if (typeof target === 'string') {
      route[slot] = target
      continue
    }
    const t = target as { route?: unknown; model?: unknown } | null
    if (!t || typeof t.route !== 'string')
      throw new HostError('E_PRESET_UNSUPPORTED', `preset ${doc.name}: model.route.${slot} names no route`, {
        detail: { capability: 'model.route', source: doc.name, slot, value: target },
      })
    route[slot] = t.route
    if (typeof t.model === 'string' && t.model !== SENTINEL) id[slot] = t.model
  }
  const pinned = {
    ...doc,
    model: { ...(doc.model as object), route, ...(Object.keys(id).length ? { id } : {}) },
  }
  return readPreset(pinned, doc.name)
}
