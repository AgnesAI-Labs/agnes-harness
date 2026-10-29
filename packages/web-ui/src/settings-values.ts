/**
 * Conversions between what settings store and what a person reads: milliseconds as seconds or
 * minutes chosen from a short list, comma lists as chips, token budgets as 128K.
 */

/** A choice in a preset list: its stored value and how it reads. */
export type SettingsPreset = { value: number; label: string }

/** `default` when nothing is stored, the matching preset, or `custom` for any other value. */
export function presetChoice(value: number | undefined, presets: readonly SettingsPreset[]): string {
  if (value === undefined) return 'default'
  return presets.some((preset) => preset.value === value) ? String(value) : 'custom'
}

/** Second presets in milliseconds, labelled by the caller's 「{count} seconds」 text. */
export function secondPresets(
  seconds: readonly number[],
  label: (count: number) => string,
): SettingsPreset[] {
  return seconds.map((count) => ({ value: count * 1000, label: label(count) }))
}

/** Minute presets in milliseconds, labelled by the caller's 「{count} minutes」 text. */
export function minutePresets(
  minutes: readonly number[],
  label: (count: number) => string,
): SettingsPreset[] {
  return minutes.map((count) => ({ value: count * 60_000, label: label(count) }))
}

/** A comma or newline separated list as its non-empty, trimmed, distinct entries. */
export function splitList(text: string | undefined): string[] {
  if (!text) return []
  return [
    ...new Set(
      text
        .split(/[,\n，]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ]
}

/** Chips back to the comma list the setting stores. */
export function joinList(entries: readonly string[]): string {
  return entries.join(', ')
}

/** 128000 → 「128K」, 1000000 → 「1M」; other numbers are grouped digits. */
export function formatTokens(value: number): string {
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}K`
  return value.toLocaleString('en-US')
}

/** 「100K」, 「1.5M」, 「200000」 or 「200,000」 → tokens; anything else is undefined. */
export function parseTokens(text: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(text.replaceAll(',', ''))
  if (!match?.[1]) return undefined
  const scale = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2]?.toLowerCase() === 'k' ? 1000 : 1
  const value = Math.round(Number(match[1]) * scale)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}
