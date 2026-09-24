import { rmSync } from 'node:fs'
import type { Host, HostSession } from '@agnes/host'
import type { EventEnvelope } from '@agnes/protocol'
import { main } from '../../src/bin.js'

const configuredDataDir = process.env.AGNES_ACP_FIXTURE_DIR
if (!configuredDataDir) throw new Error('AGNES_ACP_FIXTURE_DIR is required')
const dataDir: string = configuredDataDir

const actor = { id: 'fixture', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const event = (seq: number, type: string, data: unknown): EventEnvelope =>
  ({
    seq,
    ts: new Date(0).toISOString(),
    id: `01J6ZM2Q3R4S5T6V7W8X9Y${String(seq).padStart(3, '0')}`,
    type,
    data,
    actor,
    origin: 'model',
    trust: 'trusted',
  }) as EventEnvelope

/**
 * Test-only Host seam: the real daemon LocalEndpoint still validates and executes the entire ACP
 * exchange, while the provider side is deterministic and opens neither a port nor a production
 * faux-provider switch. This keeps the concurrency measurement about CLI/ACP process startup.
 */
const fixtureHost = (): Host => {
  let nextSession = 0
  return {
    profile: {
      name: 'local-dev',
      hash: 'sha256-fixture',
      presets: { default: 'standard', allowed: ['standard'] },
    } as Host['profile'],
    resolveActor: async () => actor,
    createSession: async () => {
      const rows: EventEnvelope[] = []
      const subscribers = new Set<(events: EventEnvelope[]) => void>()
      const append = (events: EventEnvelope[]): void => {
        rows.push(...events)
        for (const subscriber of subscribers) subscriber(events)
      }
      const session = {
        key: `agnes:local:local-dev:cli:dm:fixture-${nextSession++}`,
        preset: { name: 'standard' },
        get lastSeq() {
          return rows.length
        },
        enqueue: async () => undefined,
        run: async () => {
          const assistant = event(rows.length + 1, 'assistant/message', {
            content: [{ type: 'text', text: 'concurrency ok' }],
            stopReason: 'end_turn',
          })
          const ended = event(rows.length + 2, 'turn/end', {
            reason: 'completed',
            lastAssistantSeq: assistant.seq,
          })
          append([assistant, ended])
          return { reason: 'completed', lastSeq: ended.seq }
        },
        scan: async ({ fromSeq = 1, toSeq = Number.MAX_SAFE_INTEGER, limit = 500 }) =>
          rows.filter(({ seq }) => seq >= fromSeq && seq <= toSeq).slice(0, limit),
        onAppended: (subscriber: (events: EventEnvelope[]) => void) => {
          subscribers.add(subscriber)
          return () => subscribers.delete(subscriber)
        },
        close: async () => undefined,
      }
      return session as unknown as HostSession
    },
    close: async () => undefined,
  } as unknown as Host
}

async function run(): Promise<void> {
  try {
    process.exitCode = await main(
      process.argv.slice(2),
      {
        env: process.env,
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        cwd: dataDir,
        agnesVersion: '0.0.0-test',
      },
      {
        createHostImpl: async () => fixtureHost(),
      },
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`)
  process.exitCode = 1
})
