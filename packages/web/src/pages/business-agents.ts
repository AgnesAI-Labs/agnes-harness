import type { AgentPlan, PackageCatalogDescriptor } from '@agnes/protocol'
import { homeAdmin } from './admin-api.js'

/** Catalogue availability comes from explicit launch declarations, independently of package names. */
export function isBusinessAgent(row: PackageCatalogDescriptor): boolean {
  return (row.agents?.length ?? 0) > 0 && !row.metadata?.exampleOf
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
  resolve?: (ref: string) => Promise<AgentPlan>,
): Promise<PackageCatalogDescriptor[]> {
  const rows: PackageCatalogDescriptor[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    pages += 1
    const page = await catalog(undefined, cursor)
    rows.push(
      ...page.items
        .filter(isBusinessAgent)
        .flatMap((entry) => (entry.agents ?? []).map((agent) => ({ ...entry, agents: [agent] }))),
    )
    cursor = page.nextCursor ?? undefined
  } while (cursor && rows.length < 256 && pages < 32)
  if (!resolve) return rows
  const checked = await Promise.allSettled(
    rows.map(async (row) => {
      const declared = row.agents?.[0]
      if (!declared) throw new Error('agent unavailable')
      const plan = await resolve(declared.ref)
      if (plan.ref !== declared.ref) throw new Error('agent selection changed')
      return { ...row, agents: [{ ref: plan.ref, launch: plan.launch }] }
    }),
  )
  return checked.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
}

/** The three a new session suggests first: different kinds of work, when the catalog has them. */
const FEATURED = ['code-review', 'data-report', 'knowledge-qa']

export function featuredBusinessAgents(
  rows: readonly PackageCatalogDescriptor[],
  count = 3,
): PackageCatalogDescriptor[] {
  const rank = (row: PackageCatalogDescriptor) => {
    const index = FEATURED.indexOf(row.id.split('/').at(-1) ?? '')
    return index < 0 ? FEATURED.length : index
  }
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
    .slice(0, count)
    .map((entry) => entry.row)
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
          suggestions = { featured: featuredBusinessAgents(rows), total: rows.length }
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
  return listBusinessAgents(
    (query, cursor) => api.catalog(query, cursor),
    (ref) => api.resolveAgent(ref),
  )
})
