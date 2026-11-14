/**
 * The synchronous snapshot the `context` and `tool_call` hooks read. Both hooks run for every session of the profile, and
 * `tool_call` refuses on failure, so they never await the service: they read this snapshot, which the running service sets
 * and its shutdown clears.
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

/** One plugin instance's current snapshot; inert until the service sets it and again after `clear()`. */
export interface HookStateCell {
  get(): HookState
  set(state: HookState): void
  clear(): void
}

export function createHookStateCell(): HookStateCell {
  let current = INERT_HOOK_STATE
  return {
    get: () => current,
    set: (state) => {
      current = state
    },
    clear: () => {
      current = INERT_HOOK_STATE
    },
  }
}
