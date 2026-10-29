import type {
  AgentRef,
  DeclaredAgent,
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
} from '@agnes/protocol'
import { type BusinessAgent, businessAgentView, discoverableAgent } from '@agnes/web-admin/agents'

export type AgentCard = Omit<BusinessAgent, 'entry' | 'ref'> & {
  ref: AgentRef
  entry: PackageCatalogDescriptor | PackageInstalledDescriptor
  declaration: DeclaredAgent
  /** Real catalog data is needed only by the public package installation flow. */
  catalogAgent?: BusinessAgent
}

/** Only explicit declarations are cards. Installed inventory replaces catalog declarations for a
 * package, including removed agents; no synthetic catalog descriptors or inferred capabilities.
 */
export function declaredAgentCards(
  rows: readonly PackageCatalogDescriptor[],
  locale: 'en' | 'zh-CN',
  installed: readonly PackageInstalledDescriptor[] = [],
): AgentCard[] {
  const cards = new Map<AgentRef, AgentCard>()
  const installedIds = new Set(installed.map((entry) => entry.id))
  for (const entry of rows) {
    if (installedIds.has(entry.id) || !discoverableAgent(entry)) continue
    for (const declaration of entry.agents ?? []) {
      const catalogAgent = businessAgentView({ ...entry, agents: [declaration] }, locale)
      cards.set(declaration.ref, {
        ...catalogAgent,
        slug: encodeURIComponent(declaration.ref),
        declaration,
        catalogAgent,
      })
    }
  }
  for (const entry of installed) {
    for (const declaration of entry.agents ?? []) {
      const text = (value: { en: string; 'zh-CN'?: string }) => value[locale] ?? value.en
      const name = text(declaration.launch.title)
      const catalogEntry =
        !entry.trusted || entry.desired !== 'enabled'
          ? rows.find(
              (row) => row.id === entry.id && row.agents?.some((agent) => agent.ref === declaration.ref),
            )
          : undefined
      const catalogAgent = catalogEntry
        ? businessAgentView(
            {
              ...catalogEntry,
              agents: (catalogEntry.agents ?? []).filter((agent) => agent.ref === declaration.ref),
            },
            locale,
          )
        : undefined
      cards.set(declaration.ref, {
        ref: declaration.ref,
        entry,
        declaration,
        ...(catalogAgent ? { catalogAgent } : {}),
        slug: encodeURIComponent(declaration.ref),
        name,
        summary: text(declaration.launch.description),
        samplePrompt: declaration.launch.prompt ? text(declaration.launch.prompt.text) : undefined,
        glyph: [...name][0]?.toUpperCase() ?? '?',
        tint: [...declaration.ref].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 8, 0),
      })
    }
  }
  return [...cards.values()]
}
