import type { TableHandle } from '../seam-init.js'

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

const scoreRows = (rows: ToolIndexRow[], query: string, limit: number): ToolIndexHit[] => {
  const q = query.trim().toLocaleLowerCase()
  if (!q || limit <= 0) return []
  const hit = (value: string): boolean => value.toLocaleLowerCase().includes(q)
  return rows
    .map((row) => ({
      name: row.name,
      score: (hit(row.name) ? 3 : 0) + (hit(row.description) ? 1 : 0) + (hit(row.schema) ? 0.5 : 0),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
}

/**
 * Uses FTS5 where the adapter permits virtual tables. The current Host SQL capability gate denies
 * CREATE VIRTUAL TABLE, so that adapter deliberately lands in the persistent portable mode instead
 * of making MCP discovery unavailable. `mode` makes the downgrade observable to assembly/tests.
 */
export class SqliteToolIndex implements ToolIndex {
  readonly mode: 'fts5' | 'portable'

  constructor(private readonly table: TableHandle) {
    try {
      table.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS tool_index USING fts5(name, description, schema, tokenize='trigram')",
      )
      this.mode = 'fts5'
    } catch {
      table.exec('CREATE TABLE IF NOT EXISTS tool_index (name TEXT, description TEXT, schema TEXT)')
      this.mode = 'portable'
    }
  }

  upsert(rows: ToolIndexRow[]): void {
    this.table.transaction(() => {
      for (const row of rows) {
        this.table.run('DELETE FROM tool_index WHERE name = ?', [row.name])
        this.table.run('INSERT INTO tool_index (name, description, schema) VALUES (?, ?, ?)', [
          row.name,
          row.description,
          row.schema,
        ])
      }
    })
  }

  clear(): void {
    this.table.run('DELETE FROM tool_index')
  }

  delete(names: readonly string[]): void {
    if (names.length === 0) return
    this.table.transaction(() => {
      for (const name of names) this.table.run('DELETE FROM tool_index WHERE name = ?', [name])
    })
  }

  search(query: string, limit: number): ToolIndexHit[] {
    const term = query.trim()
    if (!term || limit <= 0) return []
    // FTS5's trigram tokenizer cannot match terms shorter than three Unicode characters. Two
    // characters are a normal Chinese search, so keep the same observable substring semantics by
    // scanning the small catalog for those queries instead of returning a false empty result.
    if (this.mode === 'portable' || Array.from(term).length < 3)
      return scoreRows(
        this.table.all<ToolIndexRow>('SELECT name, description, schema FROM tool_index'),
        term,
        limit,
      )
    const match = `"${term.replace(/"/g, '""')}"`
    return this.table.all<ToolIndexHit>(
      'SELECT name, bm25(tool_index, 3.0, 1.0, 0.5) AS score FROM tool_index WHERE tool_index MATCH ? ORDER BY score LIMIT ?',
      [match, limit],
    )
  }

  get(name: string): ToolIndexRow | undefined {
    return this.table.get<ToolIndexRow>('SELECT name, description, schema FROM tool_index WHERE name = ?', [
      name,
    ])
  }
}

export const scoreToolIndexRows = scoreRows
