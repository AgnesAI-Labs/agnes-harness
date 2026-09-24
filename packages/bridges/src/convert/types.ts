import type { EventEnvelope } from '@agnes/protocol'

export type ImportSource = 'claude-code' | 'codex' | 'pi'
export type ImportReportSource = ImportSource | 'agnes'

export type ImportOptions = {
  from?: ImportSource | 'auto'
  sessionKey?: string
  now?: () => number
  rng?: () => number
  agnesVersion?: string
}

export type ImportReport = {
  source: ImportReportSource
  imported: number
  skipped: Array<{ line: number; reason: string }>
  repaired: Array<{ seq: number; reason: string }>
  branches: { kept: 1; dropped: number }
  unsupported: Record<string, number>
}

export type ImportResult = { events: EventEnvelope[]; report: ImportReport }

export class ImportError extends Error {
  constructor(
    public readonly code: 'E_IMPORT_NO_HEADER' | 'E_IMPORT_UNKNOWN_FORMAT',
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'ImportError'
  }
}
