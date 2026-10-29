import type { PresetView } from '@agnes/core'
import { HostError } from '@agnes/host-common/errors'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { materializeRoutes } from '@agnes/host-providers/assemble/routes'

/** Fit current accounts for cold bootstrap only; replay restores the recorded model selection.
 * Preset documents and their rows stay untouched so generation identities still match. */
export function retainedModelView(
  preset: PresetView,
  profile: ResolvedProfile,
  adapters: Parameters<typeof materializeRoutes>[2],
): PresetView {
  const model = structuredClone(preset.model)
  for (const [slot, route] of Object.entries(model.route)) {
    const id = model.id[slot]
    try {
      materializeRoutes(
        {
          ...preset,
          model: {
            ...model,
            route: { primary: route },
            id: id ? { primary: id } : {},
          },
        },
        profile,
        adapters,
      )
    } catch (error) {
      if (
        !(error instanceof HostError) ||
        !['unknown-route', 'model-undeclared'].includes(String(error.detail?.reason))
      )
        throw error
      model.route[slot] = 'default'
      delete model.id[slot]
      delete model.thinking[slot]
      delete model.contextWindow?.[slot]
    }
  }
  return { ...preset, model }
}
