import type { ContentBlock } from '@agnes/protocol'
import type { ImportReport, ImportReportSource } from './types.js'

export type JsonlRow = { line: number; value: unknown }

export class Tolerance {
  private readonly skippedRows: ImportReport['skipped'] = []
  private readonly repairedRows: ImportReport['repaired'] = []
  private dropped = 0
  private readonly unsupportedKinds: Record<string, number> = Object.create(null) as Record<string, number>

  skip(line: number, reason: string): void {
    this.skippedRows.push({ line, reason })
  }
  repair(seq: number, reason: string): void {
    this.repairedRows.push({ seq, reason })
  }
  unsupported(kind: string): void {
    this.unsupportedKinds[kind] = (this.unsupportedKinds[kind] ?? 0) + 1
  }
  dropBranch(): void {
    this.dropped++
  }
  repairs(): ReadonlyArray<{ seq: number; reason: string }> {
    return this.repairedRows
  }
  finish(source: ImportReportSource, imported: number): ImportReport {
    return {
      source,
      imported,
      skipped: [...this.skippedRows],
      repaired: [...this.repairedRows],
      branches: { kept: 1, dropped: this.dropped },
      unsupported: { ...this.unsupportedKinds },
    }
  }
}

export function parseJsonl(bytes: Uint8Array, report: Tolerance): JsonlRow[] {
  const out: JsonlRow[] = []
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  for (const [index, source] of text.split('\n').entries()) {
    const raw = index === 0 ? source.replace(/^\uFEFF/, '') : source
    if (!raw.trim()) continue
    try {
      out.push({ line: index + 1, value: JSON.parse(raw) as unknown })
    } catch {
      report.skip(index + 1, 'invalid json')
    }
  }
  return out
}

export function sanitizeToolName(name: string): string {
  let safe = name.replace(/[^A-Za-z0-9_]/g, '_')
  if (!/^[A-Za-z_]/.test(safe)) safe = `t_${safe}`
  return safe.slice(0, 64)
}

export function textBlocks(text: string): ContentBlock[] {
  const limit = 1_048_576
  if (text.length === 0) return [{ type: 'text', text: '' }]
  const blocks: ContentBlock[] = []
  for (let offset = 0; offset < text.length; offset += limit)
    blocks.push({ type: 'text', text: text.slice(offset, offset + limit) })
  return blocks
}
