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
      emit: (event) => {
        for (const listener of listeners) listener({ ...event, seq: ++seq })
      },
      listening: () => listeners.size,
      handle: undefined as unknown as SessionHandle,
    }
    const record =
      (method: string, result: unknown = ++seq) =>
      async (...args: unknown[]) => {
        session.calls.push({ method, args })
        return typeof result === 'function' ? (result as (...a: unknown[]) => unknown)(...args) : result
      }
    const submit =
      (method: string) =>
      async (input: unknown, o: { commandId?: string } = {}) => {
        session.calls.push({ method, args: [input, o] })
        const text = typeof input === 'string' ? input : JSON.stringify(input)
        if (method === 'steer' && session.running) session.taken.push({ ...o, text })
        else session.pending.push({ itemId: `item-${++seq}`, preview: text, ...o })
        return seq
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
      new: async (options: NewSessionOptions) => make(options.sessionKey ?? `s-${++seq}`, options).handle,
      load: async (id: string) => {
        loads.push(id)
        const found = sessions.get(id)
        if (!found) throw Object.assign(new Error(`unknown session ${id}`), { code: 'SESSION_NOT_FOUND' })
        return found.handle
      },
      rename: async (id: string, title: string) => {
        renamed.push([id, title])
        return {}
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
  return { client, sessions, workspaces, renamed, loads, make }
}
