import type { PersistenceMetadataNamespace } from '@agnes/extension-api'

export type ToolIndexRow = { name: string; description: string; schema: string }
export type ToolIndexHit = { name: string; score: number }

export interface ToolIndex {
  clear(): void
  upsert(rows: ToolIndexRow[]): void
  /** Removes exactly the named rows, leaving every other row untouched. A name this index does not
   * hold is a no-op, not an error. */
  delete(names: readonly string[]): void
  search(query: string, limit: number): ToolIndexHit[]
  get(name: string): ToolIndexRow | undefined
}

/** What `tool_search`/`tool_describe` actually need -- read-only, no write/ownership authority. A
 * `ToolIndex` satisfies this structurally; so does `McpCatalogHub` (stage 2b, `mcp-server/catalog-hub.ts`),
 * which lets `agnes/mcp-search` depend on the hub alone instead of also reaching for the raw index. */
export type ToolIndexReader = Pick<ToolIndex, 'search' | 'get'>

const queryTerms = (query: string): string[] => [
  ...new Set(
    query
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter(Boolean),
  ),
]

const scoreRows = (rows: ToolIndexRow[], query: string, limit: number): ToolIndexHit[] => {
  const terms = queryTerms(query)
  if (!terms.length || limit <= 0) return []
  return rows
    .map((row) => {
      const name = row.name.toLocaleLowerCase()
      const description = row.description.toLocaleLowerCase()
      const schema = row.schema.toLocaleLowerCase()
      const score = terms.reduce(
        (sum, term) =>
          sum +
          (name.includes(term) ? 3 : 0) +
          (description.includes(term) ? 1 : 0) +
          (schema.includes(term) ? 0.5 : 0),
        0,
      )
      // More than the maximum score of any row without an exact tool-name term.
      return { name: row.name, score: score + (terms.includes(name) ? terms.length * 4.5 + 1 : 0) }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
}

export const scoreToolIndexRows = scoreRows

/** Small catalogs use the same portable substring ranking on every persistence provider. */
export class MetadataToolIndex implements ToolIndex {
  readonly mode = 'portable'
  constructor(private readonly ns: PersistenceMetadataNamespace) {}
  clear(): void {
    this.ns.transaction(() => {
      for (const { key } of this.ns.entries()) this.ns.delete(key)
    })
  }
  upsert(rows: ToolIndexRow[]): void {
    this.ns.transaction(() => {
      for (const row of rows) this.ns.set(row.name, row)
    })
  }
  delete(names: readonly string[]): void {
    this.ns.transaction(() => {
      for (const name of names) this.ns.delete(name)
    })
  }
  get(name: string): ToolIndexRow | undefined {
    return this.ns.get(name) as ToolIndexRow | undefined
  }
  search(query: string, limit: number): ToolIndexHit[] {
    return scoreRows(
      this.ns.entries().map(({ value }) => value as ToolIndexRow),
      query,
      limit,
    )
  }
}
