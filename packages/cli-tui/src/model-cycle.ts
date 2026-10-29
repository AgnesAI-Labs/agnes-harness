import { type ModelSelection, thinkingLevelsOf } from './views/model-picker.js'

type Listed = { route: string; id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string> }

/**
 * The model `step` places after the current one in the /model picker's order (the profile's list, each
 * route/model once), wrapping round; undefined when no other model is listed. A model that is no longer
 * listed (or none yet known) starts at the first, or the last when going back. The thinking level is kept
 * when the new model offers it, and left to the daemon's default otherwise.
 */
export function nextModel(
  models: readonly Listed[],
  current: { route: string; id: string; thinking: string } | undefined,
  step: 1 | -1,
): ModelSelection | undefined {
  const seen = new Set<string>()
  const list = models.filter((m) => !seen.has(`${m.route}/${m.id}`) && seen.add(`${m.route}/${m.id}`))
  const at = current ? list.findIndex((m) => m.route === current.route && m.id === current.id) : -1
  if (list.length === 0 || (list.length === 1 && at === 0)) return undefined
  const pick = list[at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length]
  if (!pick) return undefined
  const keep =
    pick.reasoning && current && (thinkingLevelsOf(pick) as readonly string[]).includes(current.thinking)
  return {
    route: pick.route,
    model: pick.id,
    ...(keep ? { thinking: current.thinking as NonNullable<ModelSelection['thinking']> } : {}),
  }
}
