import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type PresetView,
  presetDefaults,
  type ScanQuery,
  type StorageAdapter,
  ToolRegistry,
} from '@agnes/core'
import { openSession, readTool } from '@agnes/core/testkit'
import type { RequestBody } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { createSqliteStorage, type SqliteStorage } from '../../src/adapters/storage-sqlite.js'

const T0 = 1_757_203_200_000

/**
 * A SQLite-backed ledger directory. Its clock stands still, so a writer lease never lapses under a
 * slow run (the test sessions renew nothing); a reopened storage stands ten minutes later, so the
 * lease a killed writer left behind has lapsed and a second writer can take the session over.
 */
export function ledgerDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), `agnes-${prefix}-`))
  const open = (reopened = false): SqliteStorage =>
    createSqliteStorage({
      file: join(dir, 'sessions.db'),
      tablesDir: join(dir, 'tables'),
      clock: () => (reopened ? T0 + 600_000 : T0),
    })
  return { dir, open, remove: () => rmSync(dir, { recursive: true, force: true }) }
}

/** No step ceiling and no compaction, so one turn can run to hundreds of steps on one surface. */
export function longPreset(): PresetView {
  const d = presetDefaults()
  return {
    ...d,
    budget: { ...d.budget, maxSteps: 100_000 },
    compaction: { ...d.compaction, enabled: false },
  }
}

export function readRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  r.add(readTool(), { source: 'agnes/tools-core', trust: 'builtin' })
  return r
}

/**
 * A tool that runs one call at a time and hangs on the call `hangAt` (0-based), which is how a
 * process killed mid-tool looks to the ledger. `reached` resolves once that call has started.
 */
export function hangingTool(hangAt: number) {
  let calls = 0
  let reach!: () => void
  const reached = new Promise<void>((r) => {
    reach = r
  })
  const tool = {
    name: 'step',
    description: 'one step',
    parameters: Type.Object({}),
    meta: {
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: false,
      isOpenWorld: false,
      replay: 'safe' as const,
      costHint: undefined,
      deferLoading: undefined,
      requiresApproval: undefined,
    },
    execute: async () => {
      if (calls++ === hangAt) {
        reach()
        return new Promise<never>(() => undefined)
      }
      return { content: [{ type: 'text' as const, text: 'ok' }] }
    },
  }
  const registry = new ToolRegistry()
  registry.add(tool as never, { source: 'agnes/tools-core', trust: 'builtin' })
  return { registry, reached }
}

export type OpenOn = Parameters<typeof openSession>[0]

/** openSession over a real adapter; the testkit types its storage as the in-memory one. */
export function openOn(storage: StorageAdapter, o: Omit<OpenOn, 'storage'>): ReturnType<typeof openSession> {
  return openSession({ ...o, storage: storage as never })
}

/** Records every scan the session makes, and how many rows each returned. */
export function counted(storage: StorageAdapter) {
  const scans: Array<{ q: ScanQuery; rows: number }> = []
  const wrapped = new Proxy(storage, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop !== 'scan' || typeof value !== 'function') return value
      return async (key: string, q: ScanQuery) => {
        const rows = await value.call(target, key, q)
        scans.push({ q, rows: rows.length })
        return rows
      }
    },
  })
  return { storage: wrapped, scans }
}

/**
 * Every tool_result in a request whose tool_use is not on the assistant message directly before it:
 * an orphan the provider would reject, or a call hung on a message that did not make it.
 */
export function misplacedResults(body: RequestBody): string[] {
  const out: string[] = []
  let owner: Set<string> | undefined
  for (const m of body.messages as Array<Record<string, unknown>>) {
    if (m.role === 'assistant') {
      const calls = (m.toolCalls as Array<{ toolUseId: string }> | undefined) ?? []
      owner = new Set(calls.map((c) => c.toolUseId))
    } else if (m.role === 'tool_result') {
      const id = String(m.toolUseId)
      if (!owner?.has(id)) out.push(id)
    }
  }
  return out
}
