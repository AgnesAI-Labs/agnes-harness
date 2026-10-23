import { minimumContextBudget, type ThinkingLevel } from '@agnes/protocol'
import { fallbackT, type Translate } from './locales/index.js'

const THINKING_LABEL_KEYS: Record<ThinkingLevel, string> = {
  off: 'modelSettings.thinking.off',
  minimal: 'modelSettings.thinking.minimal',
  low: 'modelSettings.thinking.low',
  medium: 'modelSettings.thinking.medium',
  high: 'modelSettings.thinking.high',
  xhigh: 'modelSettings.thinking.xhigh',
  max: 'modelSettings.thinking.max',
}

/**
 * Pure session-model settings translation and value rules, shared by the composer model panel and
 * account defaults form. Callers render the UI: host DOM for the panel, settings controller for the form.
 */
export function modelThinkingOptions(map?: Record<string, string>, t: Translate = fallbackT) {
  return [
    { label: t('modelSettings.thinking.auto'), value: '' },
    ...Object.entries(THINKING_LABEL_KEYS)
      .filter(([level]) => map && Object.hasOwn(map, level))
      .map(([value, key]) => ({ value, label: `${t(key)} · ${value}` })),
  ]
}

/** Suffixes are explicit: 100 is 100 tokens, while 100K is 100,000 tokens. */
export function parseContextBudget(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(value.trim())
  if (!match) return undefined
  const tokens = Number(match[1]) * (match[2]?.toLowerCase() === 'm' ? 1e6 : match[2] ? 1000 : 1)
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined
}

const BUDGET_PRESETS = [32_000, 64_000, 128_000, 256_000, 512_000, 1_000_000] as const

/** Panel budget presets: keep only values between the minimum usable budget and model capacity. */
export function contextBudgetPresets(capacity: number): number[] {
  const minimum = minimumContextBudget(capacity)
  return BUDGET_PRESETS.filter((tokens) => tokens >= minimum && tokens <= capacity)
}

/** Compact token counts: 32000 → 32K, 1000000 → 1M; non-thousand capacities keep one decimal place. */
export function contextBudgetLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`
  if (tokens >= 1000) return `${Number((tokens / 1000).toFixed(1))}K`
  return String(tokens)
}
