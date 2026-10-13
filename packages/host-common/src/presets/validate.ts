import { validatePreset } from '@agnes/protocol'
import { HostError } from '../errors.js'
import { checkCompositionPatch } from '../profile/composition.js'
import type { PresetDoc } from './types.js'

const map = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const fail = (name: string, path: string): never => {
  throw new HostError('E_PRESET_UNSUPPORTED', `preset ${name}: invalid ${path}`, {
    detail: { source: name, path },
  })
}

/** Canonical consumer spellings; the original merged document remains the hash input. */
export function validatedPresetViewInput(doc: PresetDoc): PresetDoc {
  const canonical: PresetDoc = { ...doc }
  const projection: PresetDoc = { ...canonical }
  if (canonical.composition !== undefined) checkCompositionPatch(canonical.composition)
  if (
    canonical.bundles !== undefined &&
    (!Array.isArray(canonical.bundles) ||
      !canonical.bundles.every((id) => typeof id === 'string' && id.length > 0))
  )
    fail(doc.name, 'bundles')
  delete projection.composition
  delete projection.bundles
  if (map(canonical.model)) {
    const { route, ...model } = canonical.model
    // A bare route name is shorthand for the route with the sentinel model.
    projection.model = {
      ...model,
      ...(map(route)
        ? {
            route: Object.fromEntries(
              Object.entries(route).map(([slot, target]) => {
                if (typeof target !== 'string' && (!map(target) || typeof target.route !== 'string'))
                  fail(doc.name, `model.route.${slot} names no route`)
                return [slot, typeof target === 'string' ? { route: target, model: 'default' } : target]
              }),
            ),
          }
        : route === undefined
          ? {}
          : { route }),
    }
  }
  const result = validatePreset(projection)
  if (!result.ok) {
    const errors = result.errors.map(({ path, code }) => ({ path, code }))
    throw new HostError('E_PRESET_UNSUPPORTED', `preset ${doc.name}: schema validation failed`, {
      detail: { source: doc.name, errors },
    })
  }
  return canonical
}
