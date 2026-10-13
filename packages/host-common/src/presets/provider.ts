/** The provider a preset selects for one kind in its `providers` table, if it names one. */
export function presetProvider(preset: Readonly<Record<string, unknown>>, kind: string): string | undefined {
  const table = preset.providers
  const selection = table && typeof table === 'object' ? (table as Record<string, unknown>)[kind] : undefined
  const provider =
    selection && typeof selection === 'object' ? (selection as { provider?: unknown }).provider : undefined
  return typeof provider === 'string' ? provider : undefined
}
