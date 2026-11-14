// An in-memory stand-in for the owner-level SDK client: what Superagent's sessions, delivery and role models call.
import type { NewSessionOptions, SessionClient, SessionHandle } from '../../src/runtime/sessions.js'

export interface FakeEvent {
  type: string
  seq: number
  data: Record<string, unknown>
}
export interface FakeSession {
  id: string
  options?: NewSessionOptions
  calls: { method: string; args: unknown[] }[]
  running: boolean
  pending: { itemId: string; commandId?: string; preview: string }[]
  /** Messages taken into the session's history. */
  taken: { commandId?: string; text: string }[]
  assistant: string[]
  jobs: {
    id: string
    owner: 'agent' | 'human'
    status: 'running' | 'completed' | 'killed'
    command: string
  }[]
  /** Throws from `projectUI` when set, as a read that failed. */
  unreadable?: boolean
  /**
   * The daemon's receipt of each command id, kept long after the input left the inbox: the same command again is answered
   * from it and enqueues nothing; another command under that id is refused as a conflict.
   */
  receipts: Map<string, { digest: string; seq: number }>
  /** The client journal's unconfirmed submissions, which only `checkCommand` resolves. */
  journal: Map<string, { state: 'needs-confirmation'; method: string; input: unknown }>
  /**
   * Fails the next submission with an uncertain outcome: `landed` after the daemon enqueued it, `lost` before it did.
   */
  failNext?: 'landed' | 'lost' | undefined
  /** `checkCommand` cannot reach a confirmed answer either: it fails as uncertain and keeps the entry. */
  checkFails?: boolean
  /** Keeps a steer to a busy session in its inbox until the next step, as the daemon does, instead of taking it at once. */
  queueSteers?: boolean
  /** Archived by its owner: still there, and its preferences say so. */
  archived?: boolean
  /** Deleted: every call on a handle to it fails as the daemon answers for an unknown session. */
  deleted?: boolean
  emit(event: Omit<FakeEvent, 'seq'>): void
  /** How many event readers the session has. */
  listening(): number
  handle: SessionHandle
}

export function fakeClient(opts: { routes?: { route: string; models: string[]; enabled?: boolean }[] } = {}) {
  const sessions = new Map<string, FakeSession>()
  const workspaces: string[] = []
  const renamed: [string, string][] = []
  const loads: string[] = []
  /** Keys held by another principal's sessions: the daemon denies loading or creating them. */
  const foreign = new Set<string>()
  let seq = 0
  const make = (id: string, options?: NewSessionOptions): FakeSession => {
    const listeners = new Set<(event: FakeEvent) => void>()
    const session: FakeSession = {
      id,
      ...(options ? { options } : {}),
      calls: [],
      running: false,
      pending: [],
      taken: [],
      assistant: [],
      jobs: [],
      receipts: new Map(),
      journal: new Map(),
      emit: (event) => {
        for (const listener of listeners) listener({ ...event, seq: ++seq })
      },
      listening: () => listeners.size,
      handle: undefined as unknown as SessionHandle,
    }
    const record =
      (method: string, result: unknown = ++seq) =>
      async (...args: unknown[]) => {
        if (session.deleted) throw missing(id)
        session.calls.push({ method, args })
        return typeof result === 'function' ? (result as (...a: unknown[]) => unknown)(...args) : result
      }
    const enqueue = (method: string, input: unknown, commandId?: string): number => {
      const text = typeof input === 'string' ? input : JSON.stringify(input)
      const o = commandId ? { commandId } : {}
      if (method === 'steer' && session.running && !session.queueSteers) session.taken.push({ ...o, text })
      else session.pending.push({ itemId: `item-${++seq}`, preview: text, ...o })
      return ++seq
    }
    /** What the daemon answers a command: its receipt, a conflict, or a new entry in the inbox. */
    const accept = (method: string, input: unknown, commandId?: string): number => {
      const digest = `${method}\0${typeof input === 'string' ? input : JSON.stringify(input)}`
      const receipt = commandId ? session.receipts.get(commandId) : undefined
      if (receipt) {
        if (receipt.digest !== digest)
          throw Object.assign(new Error(`command ${commandId} conflicts with its receipt`), {
            code: 'CONFLICT',
          })
        return receipt.seq
      }
      const at = enqueue(method, input, commandId)
      if (commandId) session.receipts.set(commandId, { digest, seq: at })
      return at
    }
    const uncertain = (commandId: string) =>
      Object.assign(new Error('UNCERTAIN'), {
        code: 'UNCERTAIN',
        submission: { sessionId: id, commandId, state: 'needs-confirmation' },
      })
    const submit =
      (method: string) =>
      async (input: unknown, o: { commandId?: string } = {}) => {
        if (session.deleted) throw missing(id)
        session.calls.push({ method, args: [input, o] })
        const commandId = o.commandId
        if (commandId && session.journal.has(commandId)) throw uncertain(commandId)
        const failure = session.failNext
        if (failure && commandId) {
          session.failNext = undefined
          if (failure === 'landed') accept(method, input, commandId)
          session.journal.set(commandId, { state: 'needs-confirmation', method, input })
          throw uncertain(commandId)
        }
        return accept(method, input, commandId)
      }
    session.handle = {
      id,
      steer: submit('steer'),
      followUp: submit('followUp'),
      cancel: record('cancel', () => {
        session.running = false
      }),
      removeQueued: record('removeQueued', (itemId: unknown) => {
        session.pending = session.pending.filter((item) => item.itemId !== itemId)
        return ++seq
      }),
      sendNow: record('sendNow'),
      pendingCommands: async () =>
        [...session.journal].map(([commandId, entry]) => ({ commandId, state: entry.state })),
      checkCommand: record('checkCommand', (commandId: unknown) => {
        const entry = session.journal.get(commandId as string)
        if (!entry) throw new Error(`no unconfirmed command ${String(commandId)}`)
        if (session.checkFails) throw uncertain(commandId as string)
        session.journal.delete(commandId as string)
        accept(entry.method, entry.input, commandId as string)
      }),
      setModel: record('setModel', () => ({})),
      jobsControl: record('jobsControl', (input: unknown) => {
        const { jobId } = input as { jobId: string }
        const job = session.jobs.find((item) => item.id === jobId)
        if (job) job.status = 'killed'
        return { output: { ok: true } }
      }),
      jobsRead: async () => ({
        jobs: session.jobs.map((job) => ({
          ...job,
          ownerSessionId: id,
          kind: 'shell' as const,
          cwd: '/',
          code: null,
          truncated: false,
        })),
        completions: [],
      }),
      projectUI: async () => {
        if (session.deleted) throw missing(id)
        if (session.unreadable) throw new Error('projection unavailable')
        return {
          sessionId: id,
          upto: seq,
          generation: 1,
          opState: session.running ? { turn: 1, step: 1, phase: 'model' } : null,
          pendingInputs: session.pending.map(({ itemId, commandId, preview }) => ({
            itemId,
            preview,
            ...(commandId ? { commandId } : {}),
          })),
          nodes: [
            ...session.taken.map((item, index) => ({
              kind: 'user' as const,
              id: `u${index}`,
              seq: index,
              content: [{ type: 'text' as const, text: item.text }],
              ...(item.commandId ? { commandId: item.commandId } : {}),
            })),
            ...session.assistant.map((text, index) => ({
              kind: 'assistant' as const,
              id: `a${index}`,
              seq: 1000 + index,
              text,
            })),
          ],
          turns: [],
        }
      },
      events: () => ({
        [Symbol.asyncIterator]() {
          const queue: FakeEvent[] = []
          let wake: (() => void) | undefined
          let done = false
          const listener = (event: FakeEvent) => {
            queue.push(event)
            wake?.()
          }
          listeners.add(listener)
          return {
            async next() {
              while (!queue.length && !done) await new Promise<void>((resolve) => (wake = resolve))
              const value = queue.shift()
              return value ? { value, done: false } : { value: undefined, done: true }
            },
            async return() {
              done = true
              listeners.delete(listener)
              wake?.()
              return { value: undefined, done: true }
            },
          }
        },
      }),
    } as unknown as SessionHandle
    sessions.set(id, session)
    return session
  }
  const client: SessionClient = {
    workspace: {
      add: async (path: string) => {
        workspaces.push(path)
        return {}
      },
    },
    session: {
      new: async (options: NewSessionOptions) => {
        if (options.sessionKey && foreign.has(options.sessionKey)) throw denied(options.sessionKey)
        return make(options.sessionKey ?? `s-${++seq}`, options).handle
      },
      load: async (id: string) => {
        loads.push(id)
        const found = sessions.get(id)
        if (!found) throw denied(id)
        return found.handle
      },
      rename: async (id: string, title: string) => {
        const found = sessions.get(id)
        if (!found) throw missing(id)
        renamed.push([id, title])
        return { title, archived: !!found.archived }
      },
    },
    config: {
      get: async () =>
        ({
          profile: 'local-dev',
          revision: 1,
          configured: true,
          provider: null,
          effect: 'new-sessions',
          accounts: (opts.routes ?? []).map((route, index) => ({
            accountId: `a${index}`,
            label: route.route,
            providerId: 'openai',
            route: route.route,
            baseUrl: 'http://127.0.0.1',
            model: route.models[0] ?? 'm',
            models: route.models.map((id) => ({ id, name: id })),
            enabled: route.enabled ?? true,
            credentialConfigured: true,
          })),
        }) as never,
    },
  }
  /** Deletes a session: it leaves the daemon, and handles to it fail from now on. */
  const remove = (id: string) => {
    const found = sessions.get(id)
    if (found) found.deleted = true
    sessions.delete(id)
  }
  return { client, sessions, workspaces, renamed, loads, make, remove, foreign }
}

/**
 * What the daemon answers `session/load` for a session that does not exist: the denial it also gives for another
 * principal's session, so the two cannot be told apart.
 */
const denied = (id: string) =>
  Object.assign(new Error('CAPABILITY_DENIED (-32003)'), {
    data: {
      code: 'CAPABILITY_DENIED',
      method: 'session/load',
      sessionId: id,
      reason: 'session owner unavailable',
    },
  })
/** What the daemon answers a call on a session it does not know, as the SDK raises it. */
const missing = (id: string) =>
  Object.assign(new Error(`Session not found (${id})`), {
    data: { code: 'SESSION_NOT_FOUND', sessionId: id },
  })
