import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createExtensionActivationBarrier } from '@agnes/host'
import type { EventEnvelope } from '@agnes/protocol'
import { BatchEngine, type BatchJobsPort, batchJobsPort } from '../src/batch/engine.js'
import { BatchRepo } from '../src/batch/repo.js'
import { JobsRepo } from '../src/jobs/repo.js'
import { Scheduler, type SchedulerRegistry } from '../src/jobs/scheduler.js'
import { JobsService } from '../src/jobs/service.js'
import type { Tables } from '../src/storage/table.js'
import type { WorkspaceBindingEnvelope } from '../src/storage/workspaces.js'
import { sqliteTables } from './sqlite-tables.js'

export type FakeTurn = {
  /** Default true: the model calls read on the item path. */
  read?: boolean
  /** Default true: the read result carries pixels; false is a model that cannot take images. */
  image?: boolean
  reply?: string
  credits?: number
  /** The turn ends in an error with this message, as a provider 429 or 529 that outlasted its retries. */
  fail?: string
  /** Waits for the scheduler's abort signal, like a turn that never finishes. */
  hang?: boolean
}
export type FakeModel = (prompt: string, sessionKey: string, turn: number) => FakeTurn

/**
 * Item sessions whose turns append the rows a real read-then-answer turn writes. With `dir`, each
 * session's rows are kept in a file (replaced atomically) so that a killed process and its successor
 * see the same ledger. Closing a session (release) drops it from the registry, as the daemon's does.
 */
export function fakeItemSessions(model: FakeModel, options: { dir?: string; runMs?: number } = {}) {
  const memory = new Map<string, EventEnvelope[]>()
  const file = (key: string): string => join(options.dir as string, `${encodeURIComponent(key)}.json`)
  const load = (key: string): EventEnvelope[] =>
    options.dir
      ? existsSync(file(key))
        ? (JSON.parse(readFileSync(file(key), 'utf8')) as EventEnvelope[])
        : []
      : [...(memory.get(key) ?? [])]
  const save = (key: string, rows: EventEnvelope[]): void => {
    if (!options.dir) {
      memory.set(key, rows)
      return
    }
    mkdirSync(options.dir, { recursive: true })
    writeFileSync(`${file(key)}.tmp`, JSON.stringify(rows))
    renameSync(`${file(key)}.tmp`, file(key))
  }
  const prompts = new Map<string, string>()
  const turns = new Map<string, number>()
  const counters = { running: 0, maxRunning: 0, turns: 0 }
  const opened: Array<{ key: string; cwd: string }> = []
  const entries = new Map<string, ReturnType<typeof entryFor>>()
  function entryFor(key: string, cwd: string) {
    return {
      key,
      inflight: null,
      session: {
        cwd,
        enqueue: async (_target: 'next-turn' | 'next-step', message: unknown) => {
          const content = (message as { content: Array<{ text?: string }> }).content
          prompts.set(key, content.map((block) => block.text ?? '').join(''))
          return load(key).length + 1
        },
        run: async (runOptions: { until: 'turn-end'; signal: AbortSignal }) => {
          counters.running++
          counters.maxRunning = Math.max(counters.maxRunning, counters.running)
          try {
            const turn = (turns.get(key) ?? 0) + 1
            turns.set(key, turn)
            counters.turns++
            const prompt = prompts.get(key) ?? ''
            const answer = model(prompt, key, turn)
            const credits = answer.credits ?? (answer.fail ? 0 : 0.1)
            // With runMs the turn takes that long, and its first model request is written and billed
            // at its start, as in a real turn: a process killed mid-turn leaves a started, paid turn.
            let unbilled = credits
            if (options.runMs) {
              const started = load(key)
              started.push({
                seq: started.length + 1,
                type: 'turn/start',
                data: {},
              } as unknown as EventEnvelope)
              started.push({
                seq: started.length + 1,
                type: 'cost/ledger',
                data: { purpose: 'inference', effectId: `s${started.length}`, credits: credits / 2 },
              } as unknown as EventEnvelope)
              save(key, started)
              unbilled = credits / 2
              await new Promise((resolve) => setTimeout(resolve, options.runMs))
            }
            if (answer.hang) {
              await new Promise<void>((resolve) => {
                if (runOptions.signal.aborted) resolve()
                else runOptions.signal.addEventListener('abort', () => resolve(), { once: true })
              })
              return { reason: 'aborted', lastSeq: 0 }
            }
            const rows = load(key)
            const push = (type: string, data: unknown): void => {
              rows.push({ seq: rows.length + 1, type, data } as unknown as EventEnvelope)
            }
            if (answer.fail) {
              push('cost/ledger', { purpose: 'inference', effectId: `e${rows.length}`, credits: unbilled })
              push('turn/end', { reason: 'error' })
              save(key, rows)
              return { reason: 'error', lastSeq: rows.length, error: { code: 'X', message: answer.fail } }
            }
            const args = /call the read tool with (\{.*?\})\./u.exec(prompt)?.[1]
            if (args && answer.read !== false) {
              const toolUseId = `t${rows.length}`
              push('tool/call', { toolUseId, name: 'read', args: JSON.parse(args), ordinal: 0 })
              push('tool/result', {
                toolUseId,
                content:
                  answer.image === false
                    ? [{ type: 'text', text: 'The selected model does not support image input.' }]
                    : [
                        { type: 'text', text: 'Workspace image' },
                        {
                          type: 'resource_link',
                          uri: `artifact://${'a'.repeat(64)}`,
                          mimeType: 'image/png',
                          name: 'image',
                        },
                      ],
              })
            }
            push('assistant/message', { content: [{ type: 'text', text: answer.reply ?? '{}' }] })
            push('cost/ledger', { purpose: 'inference', effectId: `e${rows.length}`, credits: unbilled })
            push('turn/end', { reason: 'completed', lastAssistantSeq: rows.length })
            save(key, rows)
            return { reason: 'completed', lastSeq: rows.length }
          } finally {
            counters.running--
          }
        },
      },
    }
  }
  const registry: SchedulerRegistry = {
    open: async ({ key, cwd }) => {
      const sessionKey = key as string
      opened.push({ key: sessionKey, cwd })
      const entry = entries.get(sessionKey) ?? entryFor(sessionKey, cwd)
      entries.set(sessionKey, entry)
      return entry
    },
    get: (key) => entries.get(key),
    keys: () => [...entries.keys()],
  }
  return {
    registry,
    transcript: async (key: string): Promise<readonly EventEnvelope[]> => load(key),
    close: (key: string): void => {
      entries.delete(key)
    },
    prompts,
    opened,
    prepared: [] as string[],
    /** The principal and workspace root each prepared session was given, in order. */
    preparedFor: [] as Array<{ principalId: string; root: string }>,
    released: [] as string[],
    counters,
  }
}

/** Real jobs table, service and scheduler around fake item sessions, as the daemon wires them. */
export function batchHarness(input: {
  root: string
  model: FakeModel
  tables?: Tables
  clock?: () => number
  dir?: string
  runMs?: number
  /** Wraps the jobs port, to refuse or watch what the engine sends. */
  jobs?: (port: BatchJobsPort) => BatchJobsPort
  /** Makes reading an item session's ledger fail. */
  transcriptFails?: (sessionKey: string) => boolean
  /** Runs inside the engine's session preparation, to hold it or make it fail. */
  prepare?: (sessionKey: string) => Promise<void>
  tickMs?: number
  /** How long the engine waits on a call into the item sessions' worker. */
  portTimeoutMs?: number
}) {
  const tables = input.tables ?? sqliteTables()
  const clock = input.clock ?? (() => Date.now())
  const sessions = fakeItemSessions(input.model, {
    ...(input.dir ? { dir: input.dir } : {}),
    ...(input.runMs ? { runMs: input.runMs } : {}),
  })
  const jobsRepo = new JobsRepo(tables.table('jobs'), clock)
  const scheduler = new Scheduler({
    repo: jobsRepo,
    registry: sessions.registry,
    notices: { emit() {} } as never,
    clock,
    owner: 'test-owner',
    limits: { tickMs: 1000, lockMs: 60_000, maxStalled: 5 },
    workspaces: {
      restoreBinding: async (sessionKey: string) =>
        ({
          version: 1,
          sessionKey,
          workspaceId: 'a'.repeat(64),
          revision: 1,
          canonicalRoot: input.root,
        }) as WorkspaceBindingEnvelope,
    },
    ownership: { resolve: () => ({ active: true, principalId: 'batch' }) },
    activationBarrier: createExtensionActivationBarrier(),
    random: () => 0.5,
  })
  const service = new JobsService({
    repo: jobsRepo,
    profileHash: 'h',
    clock,
    onCancel: (jobId) => scheduler.abort(jobId),
  })
  const repo = new BatchRepo(tables.table('batches'), clock)
  const confinement: { ready: boolean | Error; asked: number } = { ready: true, asked: 0 }
  const logs: string[] = []
  const audits: unknown[] = []
  const jobs = batchJobsPort(service)
  const engine = new BatchEngine({
    repo,
    jobs: input.jobs ? input.jobs(jobs) : jobs,
    sessions: {
      prepare: async ({ sessionKey, principalId, root }) => {
        await input.prepare?.(sessionKey)
        sessions.prepared.push(sessionKey)
        sessions.preparedFor.push({ principalId, root })
      },
      transcript: async (sessionKey) => {
        if (input.transcriptFails?.(sessionKey)) throw new Error('ledger unavailable')
        return sessions.transcript(sessionKey)
      },
      release: async (sessionKey) => {
        sessions.released.push(sessionKey)
        sessions.close(sessionKey)
      },
    },
    host: {
      itemConfinementReady: async () => {
        confinement.asked++
        if (confinement.ready instanceof Error) throw confinement.ready
        return confinement.ready
      },
    },
    profileName: 'default',
    clock,
    tickMs: input.tickMs ?? 1000,
    ...(input.portTimeoutMs !== undefined ? { portTimeoutMs: input.portTimeoutMs } : {}),
    audit: (record) => audits.push(record),
    log: (message) => logs.push(message),
  })
  const run = async (batchId: string, options: { rounds?: number; onRound?: () => void } = {}) => {
    for (let round = 0; round < (options.rounds ?? 5000); round++) {
      await engine.tick()
      options.onRound?.()
      const status = await engine.status('p', batchId)
      if (status.status !== 'running') return status
      await scheduler.tick()
    }
    throw new Error(`batch ${batchId} did not finish`)
  }
  return { tables, jobsRepo, scheduler, service, repo, engine, sessions, confinement, logs, audits, run }
}
