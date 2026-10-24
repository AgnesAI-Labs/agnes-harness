import type { ThinkingLevel } from '@agnes/protocol'
import { thinkingLevelsOf } from './views/model-picker.js'

type Listed = { route: string; id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string> }

/**
 * The level after the current one in the model's own list, wrapping round; undefined when the model
 * is not in the profile or has no thinking. A level the model no longer lists starts again at the first.
 */
export function nextThinkingLevel(
  models: readonly Listed[],
  current: { route: string; id: string; thinking: string },
): ThinkingLevel | undefined {
  const item = models.find((m) => m.route === current.route && m.id === current.id)
  if (!item?.reasoning) return undefined
  const levels = thinkingLevelsOf(item)
  return levels[(levels.indexOf(current.thinking as ThinkingLevel) + 1) % levels.length]
}
