import type { PluginGenerationSnapshot } from '@agnes/package-manager'
import { sameGenerationCodeAndSources } from '@agnes/package-manager'
import type { Host, HostSession } from '../lifecycle/host.js'

type Generation = { snapshot: PluginGenerationSnapshot; host: Host }

/** A child opened on a shared Host still belongs to its parent's durable generation. */
export function inheritedGenerationId(
  key: string,
  fallback: string,
  host: Host,
  live: ReadonlyMap<string, Generation>,
  pin: (key: string) => { generationId: string } | undefined,
): string {
  const parentKey = host.kernel.get(key)?.d.log.parent?.key
  const parent = parentKey ? pin(parentKey) : undefined
  return parent && live.get(parent.generationId)?.host === host ? parent.generationId : fallback
}

export function assertGenerationAlias(
  archived: PluginGenerationSnapshot,
  loaded: PluginGenerationSnapshot,
): void {
  if (!sameGenerationCodeAndSources(archived, loaded))
    throw new Error('E_GENERATION_INTEGRITY: retained generation alias changed')
}

/** A shared current Host must not keep an unbound historical archive alive forever. */
export function collectGenerationAliases(
  live: Map<string, Generation>,
  current: Generation | undefined,
  pins: ReadonlySet<string>,
  rows: Map<string, unknown>,
  retired: Set<string>,
): void {
  for (const [id, generation] of live) {
    if (id === current?.snapshot.id || generation.host !== current?.host || pins.has(id)) continue
    if (
      [...generation.host.kernel.sessions.values()].some(
        (session) => (session as HostSession).pluginGenerationId === id,
      )
    )
      continue
    live.delete(id)
    rows.delete(id)
    retired.add(id)
  }
}
