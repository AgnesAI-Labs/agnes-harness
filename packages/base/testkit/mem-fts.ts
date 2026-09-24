import {
  scoreToolIndexRows,
  type ToolIndex,
  type ToolIndexHit,
  type ToolIndexRow,
} from '../src/mcp/index-table.js'

export class MemFts implements ToolIndex {
  readonly #rows = new Map<string, ToolIndexRow>()

  clear(): void {
    this.#rows.clear()
  }

  upsert(rows: ToolIndexRow[]): void {
    for (const row of rows) this.#rows.set(row.name, { ...row })
  }

  delete(names: readonly string[]): void {
    for (const name of names) this.#rows.delete(name)
  }

  search(query: string, limit: number): ToolIndexHit[] {
    return scoreToolIndexRows([...this.#rows.values()], query, limit)
  }

  get(name: string): ToolIndexRow | undefined {
    const row = this.#rows.get(name)
    return row ? { ...row } : undefined
  }
}
