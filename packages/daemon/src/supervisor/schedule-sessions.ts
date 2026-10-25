import { randomUUID } from 'node:crypto'
import {
  createSchedulesPort,
  type NewSessionTarget,
  type ScheduleCode,
  type ScheduleDb,
  type ScheduleJobs,
} from '@agnes/base/schedule'
import type { JobRow } from '@agnes/daemon-foundation/jobs/repo'
import { createClient, memoryJournal, type NodeClient } from '@agnes/sdk'

/** The shared worker's session catalog, as far as a target check reads it. */
export type ScheduleCatalog = {
  loops: readonly { id: string; version: string }[]
  bundles?: readonly { id: string }[]
  modelAdapters: readonly { models: readonly { id: string; route: string }[] }[]
}

/** What a new-session target is checked against, read fresh for every check. */
export type ScheduleTargetSources = {
  workspaces(): Promise<readonly { path: string; available: boolean }[]>
  normalize(path: string): Promise<string>
  catalog(): Promise<ScheduleCatalog>
  presets(): readonly string[]
}

/**
 * The workspace must be registered and present; the loop, bundles and model must be available now;
 * a preset must be allowed unless a bundle brings its own, which session admission checks.
 */
export function scheduleTargetCheck(sources: ScheduleTargetSources) {
  return async (target: NewSessionTarget): Promise<ScheduleCode | undefined> => {
    let root: string
    try {
      root = await sources.normalize(target.cwd)
    } catch {
      return 'workspace_missing'
    }
    const known = await sources.workspaces()
    if (!known.some((entry) => entry.available && (entry.path === root || entry.path === target.cwd)))
      return 'workspace_missing'
    if (target.preset && !target.bundles?.length && !sources.presets().includes(target.preset))
      return 'preset_not_allowed'
    if (!target.loop && !target.bundles?.length && !target.model) return undefined
    const catalog = await sources.catalog()
    const loop = target.loop
    if (loop && !catalog.loops.some((entry) => entry.id === loop.id && entry.version === loop.version))
      return 'loop_missing'
    const bundles = new Set((catalog.bundles ?? []).map((bundle) => bundle.id))
    if (target.bundles?.some((bundle) => !bundles.has(bundle))) return 'bundle_unavailable'
    const model = target.model
    if (
      model &&
      !catalog.modelAdapters.some((adapter) =>
        adapter.models.some((entry) => entry.id === model.model && entry.route === model.route),
      )
    )
      return 'model_missing'
    return undefined
  }
}

/** `Daily report · 2026-10-15 09:00`: the task's title and the local time the run started, read the same in every language. */
export function runTitle(title: string, at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  const when = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  const suffix = ` · ${when}`
  // Session titles are at most 80 characters; the time is the part that tells runs apart.
  return `${title.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`
}

/**
 * Opens the fresh session for one run over the same private local SDK path as chat and webhook
 * triggers, so workspace ownership, bundle admission and preset policy apply unchanged.
 */
export function scheduleSessions(
  socketPath: string,
  serverIdentity: { pid: number; processStartId: string },
) {
  const clients = new Set<NodeClient>()
  let closing = false
  const connect = () =>
    createClient({
      transport: {
        kind: 'unix',
        path: socketPath,
        ...(socketPath.startsWith('\\\\.\\pipe\\') ? { serverIdentity } : {}),
      },
      auth: { kind: 'local' },
      journal: memoryJournal('scheduled-tasks'),
    })
  return {
    async create(target: NewSessionTarget, title: string, signal?: AbortSignal): Promise<string> {
      signal?.throwIfAborted()
      if (closing) throw new Error('scheduled session admission closed')
      const client = connect()
      clients.add(client)
      const cancel = () => {
        void client.close().catch(() => undefined)
      }
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        signal?.throwIfAborted()
        await client.initialize()
        signal?.throwIfAborted()
        // A fresh key, as the Web uses for a new chat: without one, `session/new` reopens the
        // workspace's canonical session and every run would land in the same conversation.
        const session = await client.createSession({
          cwd: target.cwd,
          permission: 'default',
          sessionKey: randomUUID(),
          ...(target.preset ? { preset: target.preset } : {}),
          ...(target.bundles?.length ? { bundles: target.bundles } : {}),
          ...(target.loop ? { loop: target.loop } : {}),
        })
        signal?.throwIfAborted()
        await client.call('_agnes/v1/session.rename', { sessionId: session.id, title })
        signal?.throwIfAborted()
        if (target.model)
          await client.call('_agnes/v1/session.setModel', {
            sessionId: session.id,
            slot: 'primary',
            route: target.model.route,
            model: target.model.model,
          })
        signal?.throwIfAborted()
        return session.id
      } finally {
        signal?.removeEventListener('abort', cancel)
        // The session is durable once created; closing this transport does not end it.
        await client.close().finally(() => clients.delete(client))
      }
    },
    async close() {
      closing = true
      await Promise.all([...clients].map((client) => client.close()))
    },
  }
}

const CODES = new Set<string>([
  'workspace_missing',
  'loop_missing',
  'bundle_unavailable',
  'preset_not_allowed',
  'model_missing',
  'interrupted',
])

/** A failed attempt in the words the run history uses: a stable reason and, when useful, the detail. */
export function failureOf(
  error: string,
  info: { newSession: boolean; sessionKey?: string },
): { reason: string; detail?: string } {
  if (error === 'approval_pending_previous_run') return { reason: error }
  if (CODES.has(error)) return { reason: error }
  if (/^session owner unavailable/.test(error) || /SESSION_NOT_FOUND|unknown session/i.test(error))
    return { reason: 'session_unavailable', detail: error }
  if (info.newSession && !info.sessionKey) return { reason: 'start_failed', detail: error }
  return { reason: 'turn_error', detail: error }
}

/**
 * The schedules port plus the scheduler hooks that run a task: a new-session target is checked again
 * and opens its session just before the run; a failure is recorded with its reason, is not retried
 * when it may already have opened a session, and does not end a repeating task.
 */
export function scheduledTasks(o: {
  db: ScheduleDb
  jobs: ScheduleJobs
  clock: () => number
  socketPath: string
  serverIdentity: { pid: number; processStartId: string }
  sources: ScheduleTargetSources
}) {
  const check = scheduleTargetCheck(o.sources)
  const port = createSchedulesPort(o.db, o.jobs, o.clock, check)
  const runs = scheduleSessions(o.socketPath, o.serverIdentity)
  const newSession = (job: JobRow) => {
    const task = port.targetOf(job.idempotencyKey)
    return task?.target.kind === 'new-session' ? { title: task.title, target: task.target } : undefined
  }
  const hooks = {
    onDispatched: (job: JobRow, info: { at: number; seq?: number; reason?: string; sessionKey: string }) =>
      port.recordDispatch(job.idempotencyKey, info),
    keepWaiting: (job: JobRow) => port.stillWaiting(job.idempotencyKey),
    onSettled: (job: JobRow, info: { at: number; nextRunAt: number | null; reason?: string }) =>
      port.noteSettlement(job.idempotencyKey, info),
    unattendedApproval: (job: JobRow) =>
      port.targetOf(job.idempotencyKey)?.target.unattendedApproval ?? ('notify' as const),
    prepare: async (job: JobRow, signal?: AbortSignal, dispatching?: () => void) => {
      signal?.throwIfAborted()
      if (port.hasWaiting(job.idempotencyKey)) throw new Error('approval_pending_previous_run')
      const task = newSession(job)
      if (!task) return undefined
      // Checked again at run time: a workspace or plugin may have gone since the task was saved.
      const code = await check(task.target)
      signal?.throwIfAborted()
      if (code) throw new Error(code)
      dispatching?.()
      return { sessionKey: await runs.create(task.target, runTitle(task.title, o.clock()), signal) }
    },
    retryable: (job: JobRow) => newSession(job) === undefined,
    onFailed: (job: JobRow, info: { at: number; error: string; sessionKey?: string }) =>
      port.recordFailure(job.idempotencyKey, {
        at: info.at,
        ...failureOf(info.error, {
          newSession: newSession(job) !== undefined,
          ...(info.sessionKey ? { sessionKey: info.sessionKey } : {}),
        }),
        ...(info.sessionKey ? { sessionKey: info.sessionKey } : {}),
      }),
    recurAfterFailure: (job: JobRow) =>
      job.idempotencyKey.startsWith('schedule:') && port.stillWaiting(job.idempotencyKey),
  }
  return { ...port, hooks, close: () => runs.close() }
}
