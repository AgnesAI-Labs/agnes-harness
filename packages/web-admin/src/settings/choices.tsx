/** Presentation only: identities and selections remain backend-owned. */
export type NamedChoice = { id: string; label?: string; displayName?: string; version?: string }
type Text = (key: string) => string
export function choiceName(entry: NamedChoice, t: Text): string {
  return (
    entry.displayName ??
    entry.label ??
    (['agnes.default', 'standard', 'read-only', 'workspace-write', 'full-access', 'minimal', 'ptc'].includes(
      entry.id,
    )
      ? t(`choice.${entry.id}`)
      : entry.id)
  )
}
export function ChoiceLabel({ entry, t }: { entry: NamedChoice; t: Text }) {
  const name = choiceName(entry, t)
  return (
    <span className="agent-choice">
      <span>{name}</span>
      {(entry.version || name !== entry.id) && (
        <small>
          {name === entry.id ? '' : entry.id}
          {entry.version ? ` ${entry.version}` : ''}
        </small>
      )}
    </span>
  )
}
export type ResolvedComposition = {
  loop: { id: string; version: string }
  source: { layer: string; name: string }
  preset?: string
}
export function readComposition(value: unknown): ResolvedComposition | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as {
    selection?: { loop?: { id?: unknown; version?: unknown } }
    sources?: { loop?: { layer?: unknown; name?: unknown } }
    preset?: unknown
    capabilities?: {
      loop?: { value?: { id?: unknown; version?: unknown }; source?: { layer?: unknown; name?: unknown } }
      preset?: unknown
    }
  }
  const loop = row.capabilities?.loop?.value ?? row.selection?.loop,
    source = row.capabilities?.loop?.source ?? row.sources?.loop
  if (
    typeof loop?.id !== 'string' ||
    typeof loop.version !== 'string' ||
    typeof source?.layer !== 'string' ||
    typeof source.name !== 'string'
  )
    return undefined
  return {
    loop: { id: loop.id, version: loop.version },
    source: { layer: source.layer, name: source.name },
    ...(typeof row.preset === 'string' ? { preset: row.preset } : {}),
  }
}
