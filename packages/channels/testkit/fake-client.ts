import type {
  ApprovalVerdict,
  Credential,
  DaemonNotice,
  EventEnvelope,
  HarnessMeta,
  SessionBudgetResult,
  UITimeline,
} from '@agnes/protocol'
import { type Client, JsonRpcError, type Session } from '@agnes/sdk'

export type FakeCall = { method: string; args: unknown[] }
type Handler = (payload: unknown) => void
type LedgerEvent = EventEnvelope & { _meta: HarnessMeta }
type SessionNewOptions = Parameters<Client['session']['new']>[0]
type SessionAttachOptions = Parameters<Client['session']['attach']>[1]

export type FakeScript = {
  apis?: Partial<Awaited<ReturnType<Client['apis']>>>
  decideError?: number
}

class Queue<T> {
  private readonly items: T[] = []
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = []

  push(value: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.items.push(value)
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.items.shift()
    return value !== undefined
      ? Promise.resolve({ value, done: false })
      : new Promise((resolve) => this.waiters.push(resolve))
  }
}

export type FakeSession = Pick<
  Session,
  | 'id'
  | 'steer'
  | 'followUp'
  | 'cancel'
  | 'setPreset'
  | 'onPermissionRequest'
  | 'budget'
  | 'events'
  | 'projectUI'
  | 'cursor'
  | 'detach'
> & {
  permissionHandler?: Parameters<Session['onPermissionRequest']>[0]
}

// approval/claim/participant/ui already exist in the protocol but have not landed on the current
// SDK Client class. Keep those runner-facing ports structural while Pick pins the methods that do
// exist today, so SDK drift on the shared subset remains a compile-time failure.
export type FakeClient = Pick<Client, 'initialize' | 'apis' | 'on' | 'close'> & {
  session: {
    new: (options: SessionNewOptions) => Promise<FakeSession>
    attach(id: string, options?: SessionAttachOptions): Promise<FakeSession>
  }
  approval: {
    decide(ticket: string, verdict: ApprovalVerdict, credential: Credential): Promise<{ seq: number }>
  }
  claim: {
    once(kind: string, value: string): Promise<boolean>
    withinRateLimit(kind: string, value: string, limit: number, windowMs: number): Promise<boolean>
  }
  participant: {
    join(sessionId: string, credential: Credential): Promise<{ seq: number }>
    leave(sessionId: string): Promise<{ seq: number }>
    list(sessionId: string): Promise<{ participants: unknown[] }>
  }
  ui: {
    respond(
      sessionId: string,
      requestSeq: number,
      action: 'accept' | 'decline' | 'cancel' | 'expired',
      data?: unknown,
    ): Promise<{ seq: number }>
  }
  calls: FakeCall[]
  claimResults: Map<string, boolean>
  pushEvent(sessionId: string, event: LedgerEvent): void
  setTimeline(sessionId: string, timeline: UITimeline): void
  emitNotice(notice: DaemonNotice): void
  emit(event: string, payload: unknown): void
  fireNotFound(sessionId: string): void
}

export function createFakeClient(script: FakeScript = {}): FakeClient {
  const calls: FakeCall[] = []
  const queues = new Map<string, Queue<LedgerEvent>>()
  const timelines = new Map<string, UITimeline>()
  const notFound = new Set<string>()
  const handlers = new Map<string, Handler[]>()
  const sessions = new Map<string, FakeSession>()
  let sequence = 100

  const record = (method: string, ...args: unknown[]) => calls.push({ method, args })
  const queueFor = (id: string): Queue<LedgerEvent> => {
    let queue = queues.get(id)
    if (!queue) {
      queue = new Queue()
      queues.set(id, queue)
    }
    return queue
  }

  function makeSession(id: string): FakeSession {
    const existing = sessions.get(id)
    if (existing) return existing
    const queue = queueFor(id)
    const session: FakeSession = {
      id,
      async steer(input, options) {
        record('steer', input, options)
        return ++sequence
      },
      async followUp(input, options) {
        record('followUp', input, options)
        return ++sequence
      },
      async cancel() {
        record('cancel')
      },
      async setPreset(name) {
        record('setPreset', name)
        return { effectiveFromSeq: ++sequence }
      },
      onPermissionRequest(handler) {
        session.permissionHandler = handler
        return () => {
          if (session.permissionHandler === handler) delete session.permissionHandler
        }
      },
      async budget(): Promise<SessionBudgetResult> {
        record('budget')
        return { state: null, ledger: [] }
      },
      events(options) {
        record('events', options)
        return {
          [Symbol.asyncIterator]: () => ({ next: () => queue.next() }),
        }
      },
      async projectUI(upto, options) {
        record('projectUI', upto, options)
        return (
          timelines.get(id) ?? {
            sessionId: id,
            upto: 0,
            generation: 1,
            opState: null,
            turns: [],
            nodes: [],
          }
        )
      },
      cursor() {
        return { fromSeq: 0, generation: 1 }
      },
      async detach() {
        record('detach')
      },
    }
    sessions.set(id, session)
    return session
  }

  const client: FakeClient = {
    calls,
    claimResults: new Map(),
    async initialize() {
      record('initialize')
      return { agnesVersion: '0.0.0', capabilities: {} }
    },
    async apis() {
      record('apis')
      return {
        profile: {
          name: 'local-dev',
          resolvedProfileHash: null,
          presets: { default: 'standard', allowed: ['standard', 'channel'] },
        },
        families: [
          {
            name: 'session',
            methods: ['_agnes/v1/session.attach', '_agnes/v1/approval.decide', '_agnes/v1/directory.upsert'],
            guidance: '',
          },
        ],
        ...script.apis,
      }
    },
    session: {
      async new(options) {
        record('session.new', options)
        return makeSession(options.sessionKey ?? `s${sessions.size + 1}`)
      },
      async attach(id, options) {
        record('session.attach', id, options)
        if (notFound.delete(id)) {
          throw new JsonRpcError({
            code: -32003,
            message: 'SESSION_NOT_FOUND',
            data: { code: 'SESSION_NOT_FOUND' },
          })
        }
        return makeSession(id)
      },
    },
    approval: {
      async decide(ticket, verdict, credential) {
        record('approval.decide', ticket, verdict, credential)
        if (script.decideError !== undefined) {
          throw new JsonRpcError({
            code: script.decideError,
            message: 'APPROVAL_REJECTED',
            data: { code: 'APPROVAL_REJECTED', reason: 'self' },
          })
        }
        return { seq: ++sequence }
      },
    },
    claim: {
      async once(kind, value) {
        record('claim.once', kind, value)
        return client.claimResults.get(`${kind}:${value}`) ?? true
      },
      async withinRateLimit(kind, value, limit, windowMs) {
        record('claim.withinRateLimit', kind, value, limit, windowMs)
        return client.claimResults.get(`${kind}:${value}`) ?? true
      },
    },
    participant: {
      async join(sessionId, credential) {
        record('participant.join', sessionId, credential)
        return { seq: ++sequence }
      },
      async leave(sessionId) {
        record('participant.leave', sessionId)
        return { seq: ++sequence }
      },
      async list(sessionId) {
        record('participant.list', sessionId)
        return { participants: [] }
      },
    },
    ui: {
      async respond(sessionId, requestSeq, action, data) {
        record('ui.respond', sessionId, requestSeq, action, data)
        return { seq: ++sequence }
      },
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((candidate) => candidate !== handler),
        )
      }
    },
    async close() {
      record('close')
    },
    pushEvent(id, event) {
      queueFor(id).push(event)
    },
    setTimeline(id, timeline) {
      timelines.set(id, timeline)
    },
    emitNotice(notice) {
      client.emit('notice', notice)
    },
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    },
    fireNotFound(id) {
      notFound.add(id)
    },
  }
  return client
}
