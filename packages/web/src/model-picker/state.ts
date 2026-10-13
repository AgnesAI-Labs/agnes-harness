import { type ModelSettings, minimumContextBudget, type ThinkingLevel } from '@agnes/protocol'
import { contextBudgetPresets, modelThinkingOptions, parseContextBudget } from '@agnes/web-ui'
import type { ModelPickerOption, ModelPickerSettings } from './types.js'

type Translate = (key: string, vars?: Record<string, string | number>) => string

export function sameOption(
  left: ModelPickerOption | undefined,
  right: ModelPickerOption | undefined,
): boolean {
  return left?.route === right?.route && left?.id === right?.id
}

export type ModelEntry = { option: ModelPickerOption; index: number }
export type ModelGroup = { key: string; label: string; entries: ModelEntry[] }

/**
 * 按服务商账户分组并按搜索词过滤。`index` 是过滤后扁平列表里的位置，
 * 键盘高亮与 `model-picker-option-N` 都用它，分组标题不占位。
 */
export function groupModels(
  options: readonly ModelPickerOption[],
  query: string,
  fallbackLabel: string,
): ModelGroup[] {
  const needle = query.trim().toLowerCase()
  const groups = new Map<string, ModelGroup>()
  for (const option of options) {
    const label = option.label ?? fallbackLabel
    if (needle && ![option.id, option.route, label].some((text) => text.toLowerCase().includes(needle)))
      continue
    const key = JSON.stringify([option.route, label])
    const group = groups.get(key) ?? { key, label, entries: [] }
    group.entries.push({ option, index: 0 })
    groups.set(key, group)
  }
  let index = 0
  const ordered = [...groups.values()]
  for (const group of ordered) for (const entry of group.entries) entry.index = index++
  return ordered
}

export function flatModels(groups: readonly ModelGroup[]): ModelPickerOption[] {
  return groups.flatMap((group) => group.entries.map((entry) => entry.option))
}

/** 档位候选：首项是「自动」，其余是模型声明的档位；名称去掉原始取值后缀（「高 · high」→「高」）。 */
export function thinkingChoices(
  settings: ModelPickerSettings | undefined,
  t: Translate,
): Array<{ label: string; value: string }> {
  if (!settings?.thinkingLevelMap) return []
  return modelThinkingOptions(settings.thinkingLevelMap, t).map((option) => ({
    value: option.value,
    label: option.value ? option.label.replace(/ · .*$/, '') : t('modelSettings.presetAuto'),
  }))
}

/** 已保存的档位若不在模型声明的范围内，返回它以便就地告知用户。 */
export function unavailableThinking(
  settings: ModelPickerSettings | undefined,
  t: Translate,
): string | undefined {
  const saved = settings?.thinking
  if (!saved) return undefined
  return thinkingChoices(settings, t).some((option) => option.value === saved) ? undefined : saved
}

/** 触发按钮上跟在模型名后面的档位；自动或不可用时不显示。 */
export function thinkingBadge(settings: ModelPickerSettings | undefined, t: Translate): string | undefined {
  const saved = settings?.thinking
  if (!saved) return undefined
  return thinkingChoices(settings, t).find((option) => option.value === saved)?.label
}

export function budgetChoices(capacity: number): number[] {
  return contextBudgetPresets(capacity)
}

export type BudgetCheck = { valid: true; tokens?: number } | { valid: false; min: number; max: number }

/** 空串表示「自动」；其余必须落在「最小可用预算 到 模型容量」之间。 */
export function checkBudget(raw: string, capacity: number): BudgetCheck {
  const text = raw.trim()
  if (text === '') return { valid: true }
  const tokens = parseContextBudget(text)
  const min = minimumContextBudget(capacity)
  if (tokens === undefined || tokens < min || tokens > capacity) return { valid: false, min, max: capacity }
  return { valid: true, tokens }
}

/** 面板内的完整草稿：档位与预算一起给，避免只改一项把另一项重置。 */
export function draftSettings(thinking: string, budget: string, capacity: number): ModelSettings | undefined {
  const check = checkBudget(budget, capacity)
  if (!check.valid) return undefined
  return {
    ...(thinking ? { thinking: thinking as ThinkingLevel } : {}),
    ...(check.tokens === undefined ? {} : { contextWindow: check.tokens }),
  }
}
