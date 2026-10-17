import type { DeclaredAgent, PackageCatalogDescriptor, PackageInstalledDescriptor } from '@agnes/protocol'
import { type BusinessAgent, businessAgentView } from '@agnes/web-admin/agents'

export type AgentCard = BusinessAgent & { declaration: DeclaredAgent }

/** Only explicit launch declarations are cards; neither package prefixes nor provides imply agents. */
export function declaredAgentCards(
  rows: readonly PackageCatalogDescriptor[],
  locale: 'en' | 'zh-CN',
): AgentCard[] {
  const cards = new Map<string, AgentCard>()
  for (const entry of rows) {
    for (const declaration of entry.agents ?? []) {
      const base = businessAgentView(entry, locale)
      const text = (value: { en: string; 'zh-CN'?: string }) => value[locale] ?? value.en
      cards.set(declaration.ref, {
        ...base,
        declaration,
        slug: encodeURIComponent(declaration.ref),
        name: text(declaration.launch.title),
        summary: text(declaration.launch.description),
        samplePrompt: declaration.launch.prompt ? text(declaration.launch.prompt.text) : undefined,
      })
    }
  }
  return [...cards.values()]
}

/** Launch facade adapter: the existing start hook accepts catalog rows. Installed declarations win over
 * catalog versions; these catalog-only fields are local presentation scaffolding, never admission.
 */
export function agentCatalogRows(
  catalog: readonly PackageCatalogDescriptor[],
  installed: readonly PackageInstalledDescriptor[],
): PackageCatalogDescriptor[] {
  const rows = new Map(catalog.map((item) => [item.id, item]))
  for (const item of installed)
    rows.set(item.id, {
      ...item,
      license: 'UNKNOWN',
      sourceId: 'installed',
      retrievedAt: '',
      compatibility: 'supported',
    })
  return [...rows.values()]
}
