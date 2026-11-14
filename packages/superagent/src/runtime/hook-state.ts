/**
 * The synchronous snapshot the `context` and `tool_call` hooks read. Both hooks run for every session of the profile, and
 * `tool_call` refuses on failure, so they never await the service: they read this snapshot, which each running service
 * generation sets and its stop replaces with a refusal of Superagent's sessions.
 */
export interface HookState {
  /** By the session ids the store registered, never by key prefix: an owner can create a session with any key. */
  isSuperagentSession(sessionId: string): boolean
  promptSections(sessionId: string): {
    stable: { id: string; order: number; content: string }[]
    liveNote?: { id: string; content: string }
  }
  /** A reason to refuse the call, or undefined to allow it. */
  guardTool(call: { sessionId: string; toolName: string; input: unknown }): string | undefined
}

/** No session is a Superagent session: every tool call is allowed and no prompt section is added. */
export const INERT_HOOK_STATE: HookState = Object.freeze({
  isSuperagentSession: () => false,
  promptSections: () => ({ stable: [] }),
  guardTool: () => undefined,
})

/** The session keys Superagent opens its sessions under: its main session and each ticket's worker. */
const RESERVED = /^superagent:(?:orchestrator(?:$|\/)|worker:.)/
/** Why a session under Superagent's keys is refused before any service generation started in this process. */
export const NOT_STARTED = 'Superagent has not started yet; its sessions can use tools once it has'
/**
 * What the hooks read in a process where no service generation has taken the state over yet, such as right after the
 * daemon started or when the service could not start at all. The store that registers Superagent's sessions is not
 * open then, so the sessions under the keys Superagent opens them under, and their subagents, are refused. A session
 * the owner opened under such a key is refused too until the service starts; the registry decides from then on.
 */
export const UNCLAIMED_HOOK_STATE: HookState = Object.freeze({
  isSuperagentSession: (sessionId: string) => RESERVED.test(sessionId),
  promptSections: () => ({ stable: [] }),
  guardTool: ({ sessionId }: { sessionId: string }) => (RESERVED.test(sessionId) ? NOT_STARTED : undefined),
})

/**
 * The process's one hook state, which every application of the plugin row reads. A generation takes it over with
 * `claim`; after that, a state changes only from the one its writer expects, so a generation that stops late cannot
 * replace its successor's state.
 */
export interface HookStateHolder {
  get(): HookState
  /** Installs `state` whatever is there, as a new generation does. */
  claim(state: HookState): void
  /** Replaces `expected` with `next`; false, changing nothing, when another state replaced `expected`. */
  compareAndSet(expected: HookState, next: HookState): boolean
  /** Replaces `expected` with `residue`, what a stop leaves; false, changing nothing, when `expected` was replaced. */
  compareAndClear(expected: HookState, residue: HookState): boolean
}
export function createHookStateHolder(initial: HookState = INERT_HOOK_STATE): HookStateHolder {
  let current = initial
  const swap = (expected: HookState, next: HookState): boolean => {
    if (current !== expected) return false
    current = next
    return true
  }
  return {
    get: () => current,
    claim: (state) => {
      current = state
    },
    compareAndSet: swap,
    compareAndClear: swap,
  }
}

/** The process-wide key of the holder: the same in every copy of this module the Host loads. */
export const HOOK_STATE_SLOT = Symbol.for('agnes.superagent.hookState')
/**
 * The process's holder. The Host applies the plugin row more than once in a process (the row that runs the managed
 * service and the rows that serve sessions' hooks), each from its own copy of this module, so the holder lives on the
 * process: a frozen object under a property that is neither writable nor configurable, which no code can replace.
 */
export function processHookState(): HookStateHolder {
  const shared = globalThis as typeof globalThis & { [HOOK_STATE_SLOT]?: HookStateHolder }
  const existing = shared[HOOK_STATE_SLOT]
  if (existing) return existing
  const holder = Object.freeze(createHookStateHolder(UNCLAIMED_HOOK_STATE))
  Object.defineProperty(globalThis, HOOK_STATE_SLOT, {
    value: holder,
    writable: false,
    configurable: false,
    enumerable: false,
  })
  return holder
}

/** One generation's hold of the hook state: what its lifecycle sets, and clears to a refusal when it stops. */
export interface HookStateCell {
  get(): HookState
  /** Replaces this generation's state; does nothing once a newer generation took over. */
  set(state: HookState): void
  /** Leaves what a stop leaves in place of this generation's state; does nothing once a newer generation took over. */
  clear(): void
}
/**
 * Takes `holder` over for a generation with `initial`. `residue` is read when the generation clears its state, while its
 * store is still open, and stays in place after it stopped.
 */
export function claimHookState(
  holder: HookStateHolder,
  initial: HookState,
  residue: () => HookState,
): HookStateCell {
  let mine = initial
  holder.claim(initial)
  return {
    get: () => holder.get(),
    set(state) {
      if (holder.compareAndSet(mine, state)) mine = state
    },
    clear() {
      if (holder.get() !== mine) return
      const rest = residue()
      if (holder.compareAndClear(mine, rest)) mine = rest
    },
  }
}

/** A cell of its own, inert until set and again after `clear()`, for code that holds no generation. */
export function createHookStateCell(): HookStateCell {
  const holder = createHookStateHolder()
  return {
    get: () => holder.get(),
    set: (state) => holder.claim(state),
    clear: () => holder.claim(INERT_HOOK_STATE),
  }
}

/** The one of `ids` that `sessionId` is, or is a subagent of (`<parent>/<id>`); undefined for none. */
export function withinSessions(
  ids: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  sessionId: string,
): string | undefined {
  for (let id = sessionId; ; ) {
    if (ids.has(id)) return id
    const parent = id.lastIndexOf('/')
    if (parent <= 0) return undefined
    id = id.slice(0, parent)
  }
}

/**
 * What a stop leaves: Superagent's sessions, as read before its store closed, and their subagents are refused every
 * tool for `reason`; each keeps its live note, which is never withdrawn. Every other session passes.
 */
export function stoppedHookState(
  notes: ReadonlyMap<string, { id: string; content: string } | undefined>,
  reason: string,
): HookState {
  const sessions = new Map(notes)
  return Object.freeze({
    isSuperagentSession: (sessionId: string) => withinSessions(sessions, sessionId) !== undefined,
    promptSections(sessionId: string) {
      const note = sessions.get(sessionId)
      return note ? { stable: [], liveNote: note } : { stable: [] }
    },
    guardTool: ({ sessionId }: { sessionId: string }) =>
      withinSessions(sessions, sessionId) === undefined ? undefined : reason,
  })
}
