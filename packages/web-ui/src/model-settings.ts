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
 * 会话级模型配置的取词与取值规则。composer 的模型面板与账号级默认值表单共用这一份，
 * 所以这里只放纯函数：界面由调用方渲染（面板走宿主 DOM，账号表单走 settings 控制器）。
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

/** 面板给出的预算预设：只保留落在「最小可用预算 到 模型容量」之间的档位。 */
export function contextBudgetPresets(capacity: number): number[] {
  const minimum = minimumContextBudget(capacity)
  return BUDGET_PRESETS.filter((tokens) => tokens >= minimum && tokens <= capacity)
}

/** Token 数的紧凑写法：32000 显示 32K，1000000 显示 1M，非整千的容量留一位小数。 */
export function contextBudgetLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`
  if (tokens >= 1000) return `${Number((tokens / 1000).toFixed(1))}K`
  return String(tokens)
}
