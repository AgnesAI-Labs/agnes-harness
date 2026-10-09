import type { EventEnvelope } from '@agnes/protocol'
import { defineProviderKind, type ProviderIdentity } from './provider-kind.js'
import type { FsEntry, FsStat } from './tool.js'

export type MemoryMode = 'off' | 'ask' | 'auto'
export type MemorySettings = Readonly<import('@agnes/protocol/gen/app-server').MemorySettings>
export type MemorySource = Readonly<import('@agnes/protocol/gen/app-server').MemorySource>
export type MemoryFile = Readonly<import('@agnes/protocol/gen/app-server').MemoryFile>
/** The exact file candidate, never an injected context contribution. */
export type MemoryProposal = Readonly<{
  path: string
  baseHash: string
  newHash: string
  diff: string
  source: MemorySource
}>
export type MemorySnapshot = Readonly<{
  revision: string
  content: string
  omitted: boolean
}>
export type MemoryFilePort = Readonly<{
  read(path: string, options?: { offset?: number; limit?: number }): Promise<Uint8Array>
  write(path: string, content: Uint8Array | string): Promise<void>
  list(path: string): Promise<FsEntry[]>
  stat(path: string): Promise<FsStat>
  revision?(path: string): Promise<string | undefined>
}>
export type MemoryInspection = Readonly<import('@agnes/protocol/gen/app-server').MemoryInspection>

/** One implementation pinned to a session. Settings are live; revision snapshots are per turn. */
export interface MemorySession {
  readonly root: string
  /** Release resources opened lazily by this session; called after in-flight work drains. */
  close?(): void | Promise<void>
  snapshot(turn: number): Promise<MemorySnapshot | undefined>
  files(
    fallback: MemoryFilePort,
    source: MemorySource,
    signal: AbortSignal,
    approve: (proposal: MemoryProposal) => Promise<boolean>,
  ): MemoryFilePort
  /** Human inspection/editing is explicit and independent of the agent's off switch. */
  inspect(): Promise<MemoryInspection>
  configure(settings: Partial<MemorySettings>): Promise<MemoryInspection>
  readFile(path: string): Promise<MemoryFile>
  editFile(path: string, content: string, baseHash: string): Promise<MemoryFile>
}

export interface MemoryProvider extends ProviderIdentity {
  open(input: Readonly<{ home: string; workspaceRoot: string; sessionKey: string }>): MemorySession
}

export const memoryKind = defineProviderKind<MemoryProvider>({
  kind: 'memory',
  scope: 'session',
  versioned: true,
  validate(provider) {
    if (typeof provider.open !== 'function') throw new TypeError('Invalid memory provider')
  },
})

/** Memory may be echoed by any message, summary or tool. Export structural facts only. */
export function memoryPrivateEvent(event: Readonly<EventEnvelope>): EventEnvelope {
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : {}
  const safe: Record<string, import('@agnes/protocol').JsonValue> = { memoryContentOmitted: true }
  for (const key of ['turn', 'step', 'bytes', 'files', 'isError'] as const) {
    const value = data[key]
    if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') safe[key] = value
  }
  for (const key of ['toolUseId', 'requestId', 'effectId', 'name', 'model', 'kind', 'status'] as const) {
    const value = data[key]
    if (typeof value === 'string' && /^[A-Za-z0-9_.:@/-]{1,256}$/.test(value)) safe[key] = value
  }
  if (
    event.type === 'turn/end' &&
    typeof data.reason === 'string' &&
    ['completed', 'aborted', 'error', 'parked', 'blocked', 'budget', 'max_steps', 'interrupted'].includes(
      data.reason,
    )
  )
    safe.reason = data.reason
  if (data.tokens && typeof data.tokens === 'object' && !Array.isArray(data.tokens)) {
    const tokens: Record<string, number> = {}
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const) {
      const value = data.tokens[key]
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) tokens[key] = value
    }
    safe.tokens = tokens
  }
  return { ...event, data: safe }
}
