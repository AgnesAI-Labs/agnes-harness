import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { TableHandle } from '@agnes/daemon-foundation/storage/table'
import { grantKey } from '@agnes/plugin-runtime/host'
import type { SessionActivity } from '@agnes/protocol'
import {
  type AdmitContext,
  createOwnerInputEngine,
  type HostInputResolution,
  type OwnerInputEngineDeps,
} from '../../src/supervisor/managed-input-admission.js'
import type { ManagedInputSessionPorts } from '../../src/supervisor/managed-input-ports.js'
import { ManagedSessionInputs } from '../../src/supervisor/managed-session-inputs.js'
import { ManagedSessionRecords } from '../../src/supervisor/managed-session-records.js'
import {
  type ManagedSessionCaller,
  type ManagedSessionPorts,
  managedSessionActor,
} from '../../src/supervisor/managed-sessions.js'

/** In-memory SQLite that refuses a NUL like the production adapter does. */
export function memoryTable(): TableHandle {
  const db = new DatabaseSync(':memory:')
  const bind = (values: readonly unknown[] | undefined): SQLInputValue[] =>
    (values ?? []).map((value, index) => {
      if (typeof value === 'string' && value.includes('\u0000'))
        throw new TypeError(`bind parameter ${index} contains NUL, unsafe for SQLite TEXT`)
      return value as SQLInputValue
    })
  return {
    exec(sql, values) {
      if (values?.length) db.prepare(sql).run(...bind(values))
      else db.exec(sql)
    },
    get: (sql, values) => db.prepare(sql).get(...bind(values)) as never,
    all: (sql, values) => db.prepare(sql).all(...bind(values)) as never,
    transaction(fn) {
      db.exec('BEGIN')
      try {
        const value = fn()
        db.exec('COMMIT')
        return value
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}

type Item = { commandId: string; text: string; seq: number }

/**
 * A stand-in for core behind the held-input ports: an inbox that only accepts into an empty one, a
 * `user/message` log written when a turn takes an item, and core's dedupe, which also matches an id
 * that was withdrawn or already consumed.
 */
export function fakeCore() {
  const state = {
    seq: new Map<string, number>(),
    turn: new Map<string, number>(),
    inbox: new Map<string, Item[]>(),
    messages: new Map<string, { commandId: string; text: string; seq: number; turn: number }[]>(),
    known: new Map<string, number>(),
    running: new Set<string>(),
    archived: new Set<string>(),
    questions: new Set<string>(),
    lastEnd: new Map<string, { seq: number; reason: string; laterStart: boolean }>(),
    submits: [] as { sessionId: string; commandId: string; dedupe: boolean; text: string }[],
    scans: [] as { sessionId: string; commandId: string; fromSeq: number }[],
    withdrawals: [] as { sessionId: string; commandId: string }[],
    idle: new Set<(sessionId: string) => void>(),
    /** The next submit fails before anything is queued, like a session that cannot open. */
    failNextSubmit: false,
  }
  const next = (sessionId: string) => {
    const seq = (state.seq.get(sessionId) ?? 0) + 1
    state.seq.set(sessionId, seq)
    return seq
  }
  const inbox = (sessionId: string) => state.inbox.get(sessionId) ?? []
  const messages = (sessionId: string) => state.messages.get(sessionId) ?? []
  const ports: ManagedInputSessionPorts & {
    activity(): Promise<readonly SessionActivity[]>
    openQuestion(sessionId: string): Promise<boolean>
  } = {
    async submitInput(sessionId, input) {
      state.submits.push({ sessionId, commandId: input.commandId, dedupe: input.dedupe, text: input.text })
      if (state.failNextSubmit) {
        state.failNextSubmit = false
        throw new Error('session could not open')
      }
      const key = `${sessionId}\0${input.commandId}`
      const earlier = state.known.get(key)
      if (input.dedupe && earlier !== undefined) return { state: 'submitted', seq: earlier }
      if (state.running.has(sessionId) || inbox(sessionId).length > 0) return { state: 'busy' }
      const seq = next(sessionId)
      state.inbox.set(sessionId, [...inbox(sessionId), { commandId: input.commandId, text: input.text, seq }])
      state.known.set(key, seq)
      return { state: 'submitted', seq }
    },
    async findUserMessage(sessionId, commandId, fromSeq) {
      state.scans.push({ sessionId, commandId, fromSeq })
      const found = messages(sessionId).find((m) => m.commandId === commandId && m.seq >= fromSeq)
      return found ? { seq: found.seq, turn: found.turn } : undefined
    },
    async withdraw(sessionId, commandId) {
      state.withdrawals.push({ sessionId, commandId })
      const items = inbox(sessionId)
      if (items.some((item) => item.commandId === commandId)) {
        state.inbox.set(
          sessionId,
          items.filter((item) => item.commandId !== commandId),
        )
        return 'withdrawn'
      }
      return messages(sessionId).some((m) => m.commandId === commandId) ? 'taken' : 'absent'
    },
    archived: (sessionId) => state.archived.has(sessionId),
    lastTurnEnd: async (sessionId) => state.lastEnd.get(sessionId),
    onIdle(listener) {
      state.idle.add(listener)
      return () => void state.idle.delete(listener)
    },
    activity: async () =>
      [...state.running].map((sessionId) => ({ sessionId, state: 'running' }) as unknown as SessionActivity),
    openQuestion: async (sessionId) => state.questions.has(sessionId),
  }
  return {
    state,
    ports,
    /** A turn takes the first queued item: a `user/message` with its commandId opens turn N. */
    take(sessionId: string) {
      const [item, ...rest] = inbox(sessionId)
      if (!item) return undefined
      state.inbox.set(sessionId, rest)
      const turn = (state.turn.get(sessionId) ?? 0) + 1
      state.turn.set(sessionId, turn)
      const message = { commandId: item.commandId, text: item.text, seq: next(sessionId), turn }
      state.messages.set(sessionId, [...messages(sessionId), message])
      return message
    },
    /** Ran turns of this text, counted from the message log: "at most once" checks read this. */
    ran(sessionId: string, text: string) {
      return messages(sessionId).filter((m) => m.text === text).length
    },
  }
}

export const caller: ManagedSessionCaller = {
  owner: 'plugin/0123456789abcdef',
  packageId: '@example/companion',
  integrity: 'sha256-a',
  service: 'engine',
}
export const owner = grantKey(caller.packageId, caller.owner)

export const receipt = (receiptId: string, text = `text of ${receiptId}`): HostInputResolution => ({
  kind: 'receipt',
  receiptId,
  text,
  contentDigest: `digest:${text}`,
  source: {
    instanceId: 'feishu-1',
    pairingId: 'pair-1',
    eventId: `event-${receiptId}`,
    messageId: `message-${receiptId}`,
    kind: 'message',
    at: '2026-11-14T00:00:00.000Z',
  },
})

/** The engine over real records and inputs tables and the fake core, as the daemon wires it. */
export function inputWorld(over: Partial<Pick<OwnerInputEngineDeps, 'faults'>> = {}) {
  const table = memoryTable()
  const records = new ManagedSessionRecords(table)
  const inputs = new ManagedSessionInputs(table)
  const core = fakeCore()
  const gates = { pass: true, calls: 0 }
  const enabled = new Set<string>([owner])
  const unavailable = async (): Promise<never> => {
    throw new Error('not used by the engine')
  }
  const ports = {
    authorize: unavailable,
    records,
    forkParent: () => undefined,
    workspaceRoot: unavailable,
    resolveAgent: unavailable,
    models: unavailable,
    autoReview: unavailable,
    fullAccess: unavailable,
    sessions: {
      ...core.ports,
      create: unavailable,
      setModel: unavailable,
      setFullAccess: unavailable,
      policy: unavailable,
      submit: unavailable,
      loaded: () => true,
      view: unavailable,
      toolDetail: unavailable,
      ownerApprover: unavailable,
      cancel: unavailable,
      archive: unavailable,
    },
  } satisfies ManagedSessionPorts
  const chains = new Map<string, Promise<unknown>>()
  const serial = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const run = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(work)
    chains.set(key, run)
    return run
  }
  const engine = createOwnerInputEngine({
    ports,
    inputs,
    serial,
    gatesPass: async () => {
      gates.calls++
      return gates.pass
    },
    actor: (actorOwner, record) => managedSessionActor(actorOwner, record),
    enabled: async (rowOwner) => enabled.has(rowOwner),
    ...(over.faults ? { faults: over.faults } : {}),
  })
  /** A managed session of `owner`; `binding: null` is one opened before bindings existed. */
  const open = (
    sessionId: string,
    binding: { taskId: string; taskGeneration: number } | null = { taskId: 'task-1', taskGeneration: 1 },
  ) => {
    records.insert(
      {
        sessionId,
        owner,
        startKey: `start-${sessionId}`,
        bundle: '@example/companion#worker',
        workspace: '/work/repo',
        retention: 'task',
        permission: 'default',
        model: null,
        memoryWrites: true,
        skillInstalls: true,
      },
      binding ? { ...binding, inputDigest: 'first-input' } : undefined,
    )
    records.markStarted(sessionId)
  }
  const ctx = (sessionId: string): AdmitContext => ({
    caller,
    owner,
    record: records.get(sessionId) as NonNullable<ReturnType<typeof records.get>>,
  })
  const target = (
    sessionId: string,
    over: Partial<Record<'taskId' | 'startKey', string>> & { taskGeneration?: number } = {},
  ) => ({
    taskId: 'task-1',
    taskGeneration: 1,
    startKey: `start-${sessionId}`,
    ...over,
  })
  return { table, records, inputs, core, gates, enabled, engine, open, ctx, target }
}
