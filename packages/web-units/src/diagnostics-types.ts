import type { UITimeline } from '@agnes/protocol'

/** Which optional sections the user kept checked in the report dialog. */
export type DiagnosticsInclude = { conversation: boolean; logs: boolean; system: boolean }

export type DiagnosticsWarning = {
  source: string
  reason: 'unavailable' | 'truncated' | 'limit' | 'timeout' | 'failed'
  detail?: string
}

export type LogTail = { size: number; text: string; truncated: boolean; missing: boolean }

export type BrowserLogEntry = { ts: string; level: 'log' | 'info' | 'warn' | 'error' | 'debug'; text: string }

export type BrowserLog = { collectedAt: string; entries: BrowserLogEntry[]; dropped: number; limit: number }

/** Metadata only: artifact bytes are out of scope for bundle version 1. */
export type DiagnosticsArtifact = {
  sha256: string
  mime: string
  lane: string
  seq: number
  source: 'request-media' | 'tool-result'
  uri?: string
}

/** The JSON inlined into the offline index.html. The full ledger ships as events.jsonl, not here. */
export type DiagnosticsBundle = {
  bundleVersion: 1
  createdAt: string
  product: 'agh'
  version: string
  sessionId: string | null
  sessionTitle: string | null
  include: DiagnosticsInclude
  trace?: UITimeline
  events?: { file: 'events.jsonl'; count: number; lastSeq: number; truncated: boolean }
  artifacts: DiagnosticsArtifact[]
  logs?: { daemon?: LogTail; host?: LogTail; browser?: BrowserLog }
  system?: {
    agh?: unknown
    runtime?: unknown
    profile?: unknown
    config?: unknown
    browser: Record<string, unknown>
  }
  warnings: DiagnosticsWarning[]
}
