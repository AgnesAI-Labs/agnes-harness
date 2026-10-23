import { type ModelSettings, minimumContextBudget, type ThinkingLevel } from '@agnes/protocol'
import {
  contextBudgetPresets,
  modelThinkingOptions,
  parseContextBudget,
  type SessionAuxiliarySnapshot,
} from '@agnes/web-ui'
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
 * Group by provider account and filter by search terms. `index` is the position in the filtered flat list,
 * used by keyboard highlighting and `model-picker-option-N`; group headings occupy no index.
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

/** Effort choices: Auto first, then model-declared levels; strip raw-value suffixes from labels (High · high → High). */
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

/** Without model-declared effort levels only Auto remains; the main menu says unsupported without opening a subpage. */
export function thinkingSupported(settings: ModelPickerSettings | undefined, t: Translate): boolean {
  return thinkingChoices(settings, t).length > 1
}

/** Count of session background model slots differing from defaults; 0 means both follow defaults. */
export function changedSlots(snapshot: SessionAuxiliarySnapshot): number {
  // An unset default resolves to the preset's route, which the client cannot see, so it never counts.
  return (['fast', 'verifier'] as const).filter((slot) => {
    const fallback = snapshot.defaults?.[slot]
    return (
      !!fallback && (snapshot[slot]?.route !== fallback.route || snapshot[slot]?.model !== fallback.model)
    )
  }).length
}

/** Return a saved effort outside the model-declared range so the UI can report it inline. */
export function unavailableThinking(
  settings: ModelPickerSettings | undefined,
  t: Translate,
): string | undefined {
  const saved = settings?.thinking
  if (!saved) return undefined
  return thinkingChoices(settings, t).some((option) => option.value === saved) ? undefined : saved
}

/** Effort shown after the model name on the trigger; hidden when automatic or unavailable. */
export function thinkingBadge(settings: ModelPickerSettings | undefined, t: Translate): string | undefined {
  const saved = settings?.thinking
  if (!saved) return undefined
  return thinkingChoices(settings, t).find((option) => option.value === saved)?.label
}

export function budgetChoices(capacity: number): number[] {
  return contextBudgetPresets(capacity)
}

export type BudgetCheck = { valid: true; tokens?: number } | { valid: false; min: number; max: number }

/** An empty string means Auto; other values must fall between the minimum usable budget and model capacity. */
export function checkBudget(raw: string, capacity: number): BudgetCheck {
  const text = raw.trim()
  if (text === '') return { valid: true }
  const tokens = parseContextBudget(text)
  const min = minimumContextBudget(capacity)
  if (tokens === undefined || tokens < min || tokens > capacity) return { valid: false, min, max: capacity }
  return { valid: true, tokens }
}

/** Complete panel draft: send effort and budget together to avoid resetting one when changing the other. */
export function draftSettings(thinking: string, budget: string, capacity: number): ModelSettings | undefined {
  const check = checkBudget(budget, capacity)
  if (!check.valid) return undefined
  return {
    ...(thinking ? { thinking: thinking as ThinkingLevel } : {}),
    ...(check.tokens === undefined ? {} : { contextWindow: check.tokens }),
  }
}
