import type { ModelPickerOption, ModelPickerSettings, ModelPickerState } from './types.js'

export function sameOption(
  left: ModelPickerOption | undefined,
  right: ModelPickerOption | undefined,
): boolean {
  return left?.route === right?.route && left?.id === right?.id
}

export function sameOptions(
  left: readonly ModelPickerOption[],
  right: readonly ModelPickerOption[],
): boolean {
  return (
    left.length === right.length &&
    left.every((option, index) => sameOption(option, right[index]) && option.label === right[index]?.label)
  )
}

export function sameLevelMap(left?: Record<string, string>, right?: Record<string, string>): boolean {
  if (left === right) return true
  if (!left || !right) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

export function sameSettings(left?: ModelPickerSettings, right?: ModelPickerSettings): boolean {
  return (
    left?.thinking === right?.thinking &&
    left?.contextWindow === right?.contextWindow &&
    left?.capacity === right?.capacity &&
    sameLevelMap(left?.thinkingLevelMap, right?.thinkingLevelMap)
  )
}

export function sameState(left: ModelPickerState, right: ModelPickerState): boolean {
  return (
    left.auxiliaryAvailable === right.auxiliaryAvailable &&
    left.accessibleName === right.accessibleName &&
    left.disabled === right.disabled &&
    left.label === right.label &&
    left.pending === right.pending &&
    sameOption(left.selected, right.selected) &&
    sameOptions(left.options, right.options) &&
    sameSettings(left.settings, right.settings)
  )
}
