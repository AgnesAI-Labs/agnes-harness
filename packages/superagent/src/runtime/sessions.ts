/**
 * Superagent's sessions over the owner-level SDK client: the main session and one worker session per ticket. A session
 * belongs to Superagent only when the store registered its id, never because of its key: an owner may create a session
 * with any key.
 */
import { mkdir, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Store } from '../app/store.js'
import { runCommand } from '../app/subprocess.js'
import type { Ticket } from '../core/index.js'
import { family } from '../kv.js'
import type { SdkClient } from './sdk.js'

/** The SDK session handle, as the client returns it. */
export type SdkSession = Awaited<ReturnType<SdkClient['session']['new']>>
export type NewSessionOptions = Parameters<SdkClient['session']['new']>[0]
/** What Superagent uses of a session handle. */
export type SessionHandle = Pick<
  SdkSession,
  | 'id'
  | 'steer'
  | 'followUp'
  | 'cancel'
  | 'projectUI'
  | 'removeQueued'
  | 'sendNow'
  | 'pendingCommands'
  | 'checkCommand'
  | 'jobsRead'
  | 'jobsControl'
  | 'setModel'
  | 'events'
>
/** What Superagent uses of the SDK client: workspaces, sessions and the model configuration. */
export interface SessionClient {
  readonly workspace: { add(path: string): Promise<unknown> }
  readonly session: {
    new: (options: NewSessionOptions) => Promise<SessionHandle>
    load(id: string, options?: { history?: 'none' | 'full' }): Promise<SessionHandle>
    rename(id: string, title: string): Promise<unknown>
  }
  readonly config: Pick<SdkClient['config'], 'get'>
}

/** The interface other parts code against (frozen). */
export interface SessionAdapter {
  ensureOrchestrator(): Promise<string>
  ensureWorker(ticket: Ticket, dir: string): Promise<string>
  cancel(sessionId: string): Promise<void>
  state(
    sessionId: string,
  ): Promise<{ running: boolean; pending: { commandId?: string; itemId: string }[]; jobs: number }>
  dropPending(sessionId: string, itemIds: readonly string[]): Promise<void>
}

export const ORCHESTRATOR_KEY = 'superagent:orchestrator'
export const workerKey = (ticketId: string): string => `superagent:worker:${ticketId}`
/** The bundles and presets the role bundles of the package manifest declare. */
export const ROLE_BUNDLES = {
  orchestrator: { bundle: '@agnes/superagent#router', preset: 'superagent-router' },
  worker: { bundle: '@agnes/superagent#worker', preset: 'superagent-worker' },
} as const
/** How long a ticket's prepare command may run. */
export const PREPARE_TIMEOUT_MS = 10 * 60_000
/** The file a ticket directory holds once its prepare command and its check succeeded. */
export const PREPARED_MARKER = '.superagent-prepared'

/** The session ids Superagent opened, by role: `orchestrator`, or `worker:<ticket id>`. */
const SESSION_IDS = family<string, [role: string]>('superagent-session:')
/** The key of a session Superagent is creating for a role, until the store records its id. */
const SESSION_INTENTS = family<string, [role: string]>('superagent-session-intent:')
export type SessionRole = { kind: 'orchestrator' } | { kind: 'worker'; ticketId: string }

/**
 * The store's map of Superagent's sessions, read synchronously by the hooks. A child session (`<parent>/<id>`) belongs to
 * the role of the nearest registered session up its key.
 */
export class SessionRegistry {
  private byId?: Map<string, SessionRole>
  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'keys' | 'delete'>) {}
  private load(): Map<string, SessionRole> {
    if (this.byId) return this.byId
    const byId = new Map<string, SessionRole>()
    for (const name of this.store.keys(SESSION_IDS)) {
      const id = this.store.get(name)
      const role = name.slice(SESSION_IDS.prefix.length)
      if (id) byId.set(id, roleOf(role))
    }
    this.byId = byId
    return byId
  }
  record(role: SessionRole, id: string): void {
    this.store.set(SESSION_IDS(roleName(role)), id)
    this.store.delete(SESSION_INTENTS(roleName(role)))
    this.load().set(id, role)
  }
  /** Notes that Superagent creates the role's session under `key`, so a stop before `record` does not orphan it. */
  intend(role: SessionRole, key: string): void {
    this.store.set(SESSION_INTENTS(roleName(role)), key)
  }
  /** Whether Superagent was creating the role's session under `key`. */
  intended(role: SessionRole, key: string): boolean {
    return this.store.get(SESSION_INTENTS(roleName(role))) === key
  }
  id(role: SessionRole): string | undefined {
    return this.store.get(SESSION_IDS(roleName(role)))
  }
  /** The role of a registered session itself. */
  role(sessionId: string): SessionRole | undefined {
    return this.load().get(sessionId)
  }
  /** The role of a registered session or of a child session of one, with whether `sessionId` is the session itself. */
  owner(sessionId: string): { role: SessionRole; child: boolean } | undefined {
    for (let id = sessionId, child = false; ; child = true) {
      const role = this.load().get(id)
      if (role) return { role, child }
      const parent = id.lastIndexOf('/')
      if (parent <= 0) return undefined
      id = id.slice(0, parent)
    }
  }
  ids(): string[] {
    return [...this.load().keys()]
  }
}
const roleName = (role: SessionRole) =>
  role.kind === 'orchestrator' ? 'orchestrator' : `worker:${role.ticketId}`
const roleOf = (name: string): SessionRole =>
  name === 'orchestrator'
    ? { kind: 'orchestrator' }
    : { kind: 'worker', ticketId: name.slice('worker:'.length) }

/** A ticket's prepare command failed; the ticket fails and is not retried automatically. */
export class PrepareFailed extends Error {}
/** A session Superagent did not open holds the key of one of its roles; it is never taken over. */
export class SessionTaken extends Error {
  constructor(readonly key: string) {
    super(
      `A session ${key} exists that Superagent did not open; Superagent does not take it over. Archive or remove it, then try again.`,
    )
  }
}
/** The owner archived a ticket's worker session: the assignment fails for a person to decide; no other session opens. */
export class SessionArchived extends Error {
  constructor(readonly key: string) {
    super(
      `The owner archived the worker session ${key}; Superagent opens no other session for the ticket. Restore the session and retry the ticket, or stop it.`,
    )
  }
}
/**
 * Whether an SDK error says the session does not exist, as for one its owner deleted. Opening a session the daemon does
 * not know answers the fixed ownership denial it also gives for another principal's session; a session Superagent then
 * creates under that key is refused when it is another's (see `SessionTaken`).
 */
export function sessionMissing(error: unknown): boolean {
  const failure = error as { code?: unknown; data?: { code?: unknown; reason?: unknown } } | undefined
  const code = failure?.data?.code ?? failure?.code
  if (code === 'SESSION_NOT_FOUND' || code === 'E_SESSION_NOT_FOUND') return true
  return code === 'CAPABILITY_DENIED' && failure?.data?.reason === 'session owner unavailable'
}
/** A title the daemon accepts: one line of at most 80 characters. */
function titleOf(title: string, key: string): string {
  const line = [
    ...(title.split(/[\r\n]/)[0] ?? '').replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, '').trim(),
  ]
  return line.slice(0, 80).join('').trim() || key
}

export interface SessionsDeps {
  readonly client: SessionClient
  readonly registry: SessionRegistry
  /** The main session's directory, registered as its workspace. */
  orchestratorDir(): string
  /** The prepare command, run in a new ticket directory; empty runs nothing. */
  prepareCommand(): string
  /** Variables the prepare command runs with. */
  environment(ticket: Ticket): Record<string, string>
  /** Checks a prepared directory, such as its local git configuration; throws to fail the ticket. */
  verify?(dir: string, signal: AbortSignal): Promise<void>
  /** Text appended to a new worker session's system prompt. */
  workerPrompt?(ticket: Ticket, dir: string): string | undefined
  /** Writes what the worker is told about its ticket into its directory; runs before each open. */
  instructions?(ticket: Ticket, dir: string): Promise<void>
  /** Selects the role's model on a session: once when it is created. */
  applyModel?(role: 'orchestrator' | 'worker', session: SessionHandle): Promise<void>
  readonly lifetime: AbortSignal
}
export interface SessionJob {
  id: string
  name: string
  /** `child` for a subagent. */
  kind: string
}

/** Superagent's sessions: the frozen adapter plus what the executor reads of its workers. */
export class Sessions implements SessionAdapter {
  private readonly handles = new Map<string, Promise<SessionHandle>>()
  constructor(private readonly deps: SessionsDeps) {}
  get registry(): SessionRegistry {
    return this.deps.registry
  }

  async ensureOrchestrator(): Promise<string> {
    const dir = this.deps.orchestratorDir()
    await mkdir(dir, { recursive: true })
    return this.ensure({ kind: 'orchestrator' }, dir, 'Superagent orchestrator')
  }
  /**
   * Prepares the ticket directory unless it is prepared, and opens the ticket's worker session in it. The directory is
   * created and the prepare command runs inside it, checking the repository out into `repo/`; it counts as prepared only
   * once the prepare command and the check succeeded and wrote the marker. A directory without the marker, which a
   * stopped or failed prepare left, is prepared again from an empty directory. A failed prepare command throws
   * `PrepareFailed` and removes the directory only when it left it empty.
   */
  async ensureWorker(ticket: Ticket, dir: string): Promise<string> {
    if (!(await exists(join(dir, PREPARED_MARKER)))) await this.prepare(ticket, dir)
    await this.deps.instructions?.(ticket, dir)
    return this.ensure({ kind: 'worker', ticketId: ticket.id }, dir, ticket.title, ticket)
  }
  private async prepare(ticket: Ticket, dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const command = this.deps.prepareCommand().trim()
    const signal = AbortSignal.any([this.deps.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
    if (command) {
      const result = await runCommand(['sh', '-c', command], {
        cwd: dir,
        env: this.deps.environment(ticket),
        signal,
        timeoutMs: PREPARE_TIMEOUT_MS,
      }).catch((error: unknown) => ({ code: -1, stdout: '', stderr: String(error) }))
      if (result.code !== 0) {
        if (!(await readdir(dir).catch(() => ['?'])).length) await rmdir(dir).catch(() => {})
        const output = (result.stderr || result.stdout).trim().slice(-2000)
        throw new PrepareFailed(
          `The prepare command failed (${result.code === -1 ? 'stopped' : `exit ${result.code}`})${output ? `: ${output}` : ''}`,
        )
      }
    }
    this.deps.lifetime.throwIfAborted()
    await this.deps.verify?.(dir, this.deps.lifetime)
    const marker = join(dir, PREPARED_MARKER)
    await writeFile(`${marker}.tmp`, `${new Date().toISOString()}\n`)
    await rename(`${marker}.tmp`, marker)
  }
  /**
   * Loads the role's session, or creates it with the role's bundle and preset. A registered session its owner deleted is
   * created again under the same key; one its owner archived fails a worker's assignment instead, and no other session
   * opens. An unregistered session under the role's key is taken over only when Superagent was creating it (see
   * `SessionRegistry.intend`); any other is the owner's, and is refused.
   */
  private async ensure(role: SessionRole, dir: string, title: string, ticket?: Ticket): Promise<string> {
    const { client, registry } = this.deps
    const key = role.kind === 'orchestrator' ? ORCHESTRATOR_KEY : workerKey(role.ticketId)
    await client.workspace.add(dir)
    const known = registry.id(role)
    if (known) this.handles.delete(known)
    const found = await (known ? this.handle(known) : client.session.load(key, { history: 'none' })).catch(
      (error: unknown) => {
        if (sessionMissing(error)) return undefined
        throw error
      },
    )
    if (found && !known && !registry.intended(role, key)) throw new SessionTaken(key)
    const session = found ?? (await this.create(role, key, dir, ticket, !!known))
    if (!known || !found) {
      this.handles.set(session.id, Promise.resolve(session))
      registry.record(role, session.id)
    }
    const preferences = (await client.session.rename(session.id, titleOf(title, key))) as
      | { archived?: boolean }
      | undefined
    if (role.kind === 'worker' && preferences?.archived) throw new SessionArchived(key)
    return session.id
  }
  private async create(
    role: SessionRole,
    key: string,
    dir: string,
    ticket: Ticket | undefined,
    deleted: boolean,
  ): Promise<SessionHandle> {
    const { bundle, preset } = ROLE_BUNDLES[role.kind]
    const prompt = ticket && this.deps.workerPrompt?.(ticket, dir)
    this.deps.registry.intend(role, key)
    const created = await this.deps.client.session
      .new({
        cwd: dir,
        sessionKey: key,
        permission: 'full-access',
        bundles: [bundle],
        preset,
        ...(prompt ? { systemPromptAppend: prompt } : {}),
      })
      .catch((error: unknown) => {
        if (deleted)
          throw new Error(`The session ${key} was deleted and could not be opened again: ${String(error)}`, {
            cause: error,
          })
        // Another principal's session holds the key.
        if (sessionMissing(error)) throw new SessionTaken(key)
        throw error
      })
    if (created.id !== key) throw new Error(`The session for ${key} was created as ${created.id}`)
    await this.deps.applyModel?.(role.kind, created)
    return created
  }
  /** Forgets a session's handle, such as one to a session that was deleted, so the next use loads it again. */
  forget(sessionId: string): void {
    this.handles.delete(sessionId)
  }
  /** The session's handle, loaded once without replaying its history. */
  handle(sessionId: string): Promise<SessionHandle> {
    let handle = this.handles.get(sessionId)
    if (!handle) {
      handle = this.deps.client.session.load(sessionId, { history: 'none' })
      handle.catch(() => this.handles.delete(sessionId))
      this.handles.set(sessionId, handle)
    }
    return handle
  }
  async cancel(sessionId: string): Promise<void> {
    await (await this.handle(sessionId)).cancel()
  }
  async state(sessionId: string) {
    const session = await this.handle(sessionId)
    const [ui, jobs] = await Promise.all([session.projectUI(), this.jobs(sessionId)])
    return {
      running: ui.opState !== null && !ui.opState.parked,
      pending: (ui.pendingInputs ?? []).map((item) => ({
        itemId: item.itemId,
        ...(item.commandId ? { commandId: item.commandId } : {}),
      })),
      jobs: jobs.length,
    }
  }
  async dropPending(sessionId: string, itemIds: readonly string[]): Promise<void> {
    const session = await this.handle(sessionId)
    for (const itemId of itemIds) await session.removeQueued(itemId)
  }
  /** The jobs of the session's model that run, such as shell jobs and subagents, but those in `except`. */
  async jobs(sessionId: string, except?: ReadonlySet<string>): Promise<SessionJob[]> {
    const { jobs } = await (await this.handle(sessionId)).jobsRead()
    return jobs
      .filter((job) => job.owner === 'agent' && job.status === 'running' && !except?.has(job.id))
      .map((job) => ({
        id: job.id,
        kind: job.kind,
        name: job.command.split('\n')[0]?.trim().slice(0, 80) || job.id,
      }))
  }
  /** Kills the session's running jobs but those in `except`; one failure stops none other. */
  async killJobs(sessionId: string, except?: ReadonlySet<string>): Promise<void> {
    const session = await this.handle(sessionId)
    const failures: unknown[] = []
    for (const job of await this.jobs(sessionId, except))
      await session
        .jobsControl({ operation: 'kill', jobId: job.id })
        .catch((error: unknown) => failures.push(error))
    if (failures.length) throw new AggregateError(failures, `Killing the jobs of ${sessionId} failed`)
  }
  /** The text of the session's last answer, and its messages for the transcript resource. */
  async transcript(sessionId: string): Promise<{ type: 'user' | 'assistant'; text: string }[]> {
    const ui = await (await this.handle(sessionId)).projectUI()
    return ui.nodes.flatMap((node): { type: 'user' | 'assistant'; text: string }[] =>
      node.kind === 'assistant'
        ? [{ type: 'assistant' as const, text: node.text }]
        : node.kind === 'user'
          ? [
              {
                type: 'user' as const,
                text: node.content
                  .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
                  .join(' '),
              },
            ]
          : [],
    )
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}
