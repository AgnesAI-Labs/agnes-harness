import type { WorkspaceBindingRecord } from '../workspace-binding.js'
import { ensure, type TableHandle } from './table.js'
import type { WorkspaceBindingStore } from './workspaces.js'

export type ManagedChatRoots = { current?: string; legacy?: string; currentError?: { code: string } }
export type LegacyChatReadGrant = Readonly<{
  sessionKey: string
  workspaceId: string
  root: string
  source: 'existing' | 'derived' | 'schedule'
  directoryIdentity?: string
}>
export type LegacyScheduleSnapshot = { scheduleId: string; targetRoot: string; revision?: number }
export type ScheduledBindingReservation = {
  runId: string
  jobKey: string
  taskId: string
  revision: number
  sessionKey: string
  root: string
}
type Source = {
  source: LegacyChatReadGrant['source']
  root: string
  workspaceId?: string
  state: 'pending' | 'committed' | 'interrupted'
  parentKey?: string
  runId?: string
  jobKey?: string
  taskId?: string
  revision?: number
}
type AuthorityState = {
  initialized: boolean
  legacyDirectoryIdentity?: string | null
  schedules: Record<string, { root: string; revision?: number; revoked?: boolean }>
  sources: Record<string, Source>
}
const issued = new WeakSet<object>()
export function assertLegacyChatReadGrant(value: unknown): asserts value is LegacyChatReadGrant {
  if (!value || typeof value !== 'object' || !issued.has(value))
    throw new TypeError('legacy chat grant was not issued by the daemon authority')
}

/** Internal provenance, separate from write-once bindings. Initialization and compatibility freeze share one transaction. */
export class ManagedChatAuthority {
  private memory: AuthorityState = { initialized: false, schedules: {}, sources: {} }
  constructor(
    private readonly table: TableHandle | undefined,
    private readonly bindings: WorkspaceBindingStore,
    readonly legacyRoot?: string,
  ) {
    if (table)
      ensure(
        table,
        'CREATE TABLE IF NOT EXISTS managed_chat_authority (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)',
      )
  }
  private read(): AuthorityState {
    const raw = this.table?.get<{ payload: string }>(
      'SELECT payload FROM managed_chat_authority WHERE id = 1',
    )
    return raw ? (JSON.parse(raw.payload) as AuthorityState) : structuredClone(this.memory)
  }
  private mutate(fn: (state: AuthorityState) => void, inTransaction = false): void {
    const apply = () => {
      const state = this.read()
      fn(state)
      if (this.table)
        this.table.exec(
          'INSERT INTO managed_chat_authority (id,payload) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
          [JSON.stringify(state)],
        )
      else this.memory = state
    }
    if (this.table && !inTransaction) this.table.transaction(apply)
    else apply()
  }
  async initialize(snapshot: {
    bindings: readonly WorkspaceBindingRecord[]
    schedules: readonly LegacyScheduleSnapshot[]
    legacyDirectoryIdentity?: string | null
  }): Promise<void> {
    this.mutate((state) => {
      if (state.initialized) return
      if (snapshot.legacyDirectoryIdentity !== undefined)
        state.legacyDirectoryIdentity = snapshot.legacyDirectoryIdentity
      for (const binding of snapshot.bindings)
        if (binding.canonicalRoot === this.legacyRoot)
          state.sources[binding.sessionKey] = {
            source: 'existing',
            root: binding.canonicalRoot,
            workspaceId: binding.workspaceId,
            state: 'committed',
          }
      for (const schedule of snapshot.schedules)
        if (schedule.targetRoot === this.legacyRoot)
          state.schedules[schedule.scheduleId] = {
            root: schedule.targetRoot,
            ...(schedule.revision !== undefined ? { revision: schedule.revision } : {}),
          }
      state.initialized = true
    })
  }
  get legacyDirectoryIdentity(): string | null | undefined {
    return this.initialized().legacyDirectoryIdentity
  }
  private initialized(state = this.read()): AuthorityState {
    if (!state.initialized) throw new Error('managed chat authority is not initialized')
    return state
  }
  hasSource(sessionKey: string, root: string): boolean {
    const source = this.initialized().sources[sessionKey]
    return root === this.legacyRoot && source?.root === root && source.state !== 'interrupted'
  }
  async authorizeExisting(sessionKey: string): Promise<LegacyChatReadGrant | undefined> {
    const source = this.initialized().sources[sessionKey]
    const binding = this.bindings.get(sessionKey)
    if (
      !source ||
      source.state !== 'committed' ||
      !binding ||
      binding.canonicalRoot !== this.legacyRoot ||
      source.root !== binding.canonicalRoot ||
      source.workspaceId !== binding.workspaceId
    )
      return undefined
    const grant = Object.freeze({
      sessionKey,
      workspaceId: binding.workspaceId,
      root: binding.canonicalRoot,
      source: source.source,
      ...(this.legacyDirectoryIdentity ? { directoryIdentity: this.legacyDirectoryIdentity } : {}),
    })
    issued.add(grant)
    return grant
  }
  async bindDerived(parentKey: string, childKey: string): Promise<void> {
    const parent = await this.authorizeExisting(parentKey)
    if (!parent) {
      if (this.bindings.get(parentKey)?.canonicalRoot !== this.legacyRoot) return
      throw new Error('derived legacy binding has no authorized parent')
    }
    this.mutate((state) => {
      this.initialized(state)
      const existing = state.sources[childKey]
      if (existing && (existing.parentKey !== parentKey || existing.root !== parent.root))
        throw new Error('derived binding source conflicts')
      state.sources[childKey] = {
        source: 'derived',
        root: parent.root,
        workspaceId: parent.workspaceId,
        state: 'committed',
        parentKey,
      }
    })
  }
  scheduleEligible(taskId: string, root: string): boolean {
    const schedule = this.initialized().schedules[taskId]
    return root === this.legacyRoot && schedule?.root === root && !schedule.revoked
  }
  revokeSchedule(taskId: string, inTransaction = false): void {
    this.mutate((state) => {
      this.initialized(state)
      const row = state.schedules[taskId]
      if (row) row.revoked = true
    }, inTransaction)
  }
  reserveScheduledBinding(input: ScheduledBindingReservation): void {
    this.mutate((state) => {
      this.initialized(state)
      const schedule = state.schedules[input.taskId]
      if (!schedule || schedule.revoked || schedule.root !== input.root || input.root !== this.legacyRoot)
        throw new Error('schedule is not eligible for legacy chats')
      for (const [key, source] of Object.entries(state.sources))
        if (source.runId === input.runId && key !== input.sessionKey)
          throw new Error('schedule run already reserved another session')
      const existing = state.sources[input.sessionKey]
      const source: Source = {
        source: 'schedule',
        root: input.root,
        state: 'pending',
        runId: input.runId,
        jobKey: input.jobKey,
        taskId: input.taskId,
        revision: input.revision,
      }
      if (existing) {
        if (
          existing.runId !== input.runId ||
          existing.root !== input.root ||
          existing.taskId !== input.taskId ||
          existing.state === 'interrupted'
        )
          throw new Error('scheduled binding conflicts')
        return
      }
      state.sources[input.sessionKey] = source
    })
  }
  commitScheduledBinding(sessionKey: string): void {
    this.mutate((state) => {
      this.initialized(state)
      const source = state.sources[sessionKey]
      const binding = this.bindings.get(sessionKey)
      if (
        !source ||
        source.source !== 'schedule' ||
        source.state === 'interrupted' ||
        !binding ||
        binding.canonicalRoot !== source.root
      )
        throw new Error('scheduled binding cannot be committed')
      source.workspaceId = binding.workspaceId
      source.state = 'committed'
    })
  }
  interruptScheduledBinding(runId: string): void {
    this.mutate((state) => {
      this.initialized(state)
      for (const source of Object.values(state.sources))
        if (source.runId === runId && source.state === 'pending') source.state = 'interrupted'
    })
  }
}
