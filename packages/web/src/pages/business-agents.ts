import type { PackageCatalogDescriptor } from '@agnes/protocol'
import { discoverableAgent, exampleDiscovery } from '@agnes/web-admin/agents'
import { applicationAgents } from '@agnes/web-client'
import { homeAdmin } from './admin-api.js'

/** Catalogue availability comes from explicit launch declarations, independently of package names. */
export function isBusinessAgent(row: PackageCatalogDescriptor): boolean {
  return (row.agents?.length ?? 0) > 0
}

/** Every business agent the catalog offers, in catalog order. */
export async function listBusinessAgents(
  catalog: (
    query: string | undefined,
    cursor: string | undefined,
  ) => Promise<{
    items: readonly PackageCatalogDescriptor[]
    nextCursor?: string | null
  }>,
): Promise<PackageCatalogDescriptor[]> {
  const rows: PackageCatalogDescriptor[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    pages += 1
    const page = await catalog(undefined, cursor)
    rows.push(
      ...page.items
        .map((row) => ({ ...row, agents: applicationAgents(row.agents ?? []) }))
        .filter((row) => isBusinessAgent(row) && discoverableAgent(row))
        .flatMap((entry) => (entry.agents ?? []).map((agent) => ({ ...entry, agents: [agent] }))),
    )
    cursor = page.nextCursor ?? undefined
  } while (cursor && rows.length < 256 && pages < 32)
  return rows
}

/** Suggestions retain the explicit catalog order; names do not imply agent categories. */
export function featuredBusinessAgents(
  rows: readonly PackageCatalogDescriptor[],
  count = 3,
): PackageCatalogDescriptor[] {
  return rows.filter((row) => exampleDiscovery(row).featured).slice(0, count)
}

export type BusinessAgentSuggestions = Readonly<{
  featured: readonly PackageCatalogDescriptor[]
  total: number
}>

const NONE: BusinessAgentSuggestions = { featured: [], total: 0 }

/** What a new session suggests. Empty until the catalog has been read, and when it cannot be. */
export function createBusinessAgentSuggestions(read: () => Promise<PackageCatalogDescriptor[]>) {
  let suggestions = NONE
  let reading: Promise<void> | undefined
  const listeners = new Set<() => void>()
  return {
    getSnapshot: (): BusinessAgentSuggestions => suggestions,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** Read the catalog again; concurrent callers share one read. */
    refresh(): Promise<void> {
      reading ??= read()
        .then((rows) => {
          suggestions = {
            featured: featuredBusinessAgents(rows),
            total: rows.filter((row) => exampleDiscovery(row).featured).length,
          }
          for (const listener of listeners) listener()
        })
        // No admin access or no catalog: the composer keeps its static placeholder.
        .catch(() => undefined)
        .finally(() => {
          reading = undefined
        })
      return reading
    },
  }
}

export const businessAgentSuggestions = createBusinessAgentSuggestions(async () => {
  const { api } = await homeAdmin()
  return listBusinessAgents((query, cursor) => api.catalog(query, cursor))
})
