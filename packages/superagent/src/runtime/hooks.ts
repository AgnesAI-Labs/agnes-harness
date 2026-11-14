// Adapted from dsh-superagent (MIT)
/**
 * The `context` and `tool_call` hooks. Both run for every session of the profile, and `tool_call` refuses when it fails,
 * so both decide synchronously from the hook state and never wait for the service. A session is Superagent's only when the
 * store registered it (or its parent, for a subagent); every other session passes untouched.
 */
import type { PluginContextFacets, PromptSection } from '@agnes/extension-api'
import type { Store } from '../app/store.js'
import { liveTicket } from '../core/index.js'
import type { HookState, HookStateCell } from './hook-state.js'
import type { SessionRegistry, SessionRole } from './sessions.js'

/**
 * Superagent's prompt section and its live note. The prompt-section order guard reads the literal sections below, so
 * they are written out where the hooks return them.
 */
export const POLICY_SECTION = { id: 'superagent:policy', order: 180 } as const
export const NOTICE_ORDER = 181
const ENDED = 'Ticket ended; new work needs a new authorized ticket'
/** What the main session is told when it would wait: what it waits for comes to it, and a waiting step holds back the next. */
export const NO_WAIT =
  "Reports, follow_up notices, new candidates and a background job's end with its output arrive by themselves as messages; " +
  'end the turn instead of waiting for them.'
/** What a main session outside the router preset is told when its command would wait the shell's default. */
export const DEFAULT_WAIT =
  'This shell waits up to 60 seconds by default: pass timeoutMs of at most 30000, or background: true, ' +
  'as a waiting step holds back new candidates.'
/** `sleep` at a command position: the start, after ; & | ( { ! ` or a newline, or after a keyword or a command that runs it. */
const SLEEP =
  /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/
/**
 * The main session's guard: it refuses a shell command that runs sleep or asks to hold the step longer than 30 seconds,
 * and a job wait longer than 5 seconds. The router preset ends a foreground command after 5 seconds; a session outside
 * it holds a command the shell's default, so a command then needs a timeout or the background.
 */
export function noWait(name: string, input: unknown, routed = true): string | undefined {
  const args = (input ?? {}) as {
    command?: unknown
    timeoutMs?: unknown
    background?: unknown
    waitMs?: unknown
  }
  if (name === 'shell') {
    const sleeps = typeof args.command === 'string' && SLEEP.test(args.command)
    if (sleeps || (typeof args.timeoutMs === 'number' && args.timeoutMs > 30_000)) return NO_WAIT
    if (args.timeoutMs === undefined && args.background !== true && !routed) return DEFAULT_WAIT
  }
  if (name === 'job_output' && typeof args.waitMs === 'number' && args.waitMs > 5_000) return NO_WAIT
  return undefined
}

export interface HookStateDeps {
  readonly registry: Pick<SessionRegistry, 'owner'>
  readonly store: Pick<Store, 'tickets'>
  /** Why Superagent's sessions cannot run now, such as during startup; undefined once ready. */
  unavailable(): string | undefined
  readonly prompt: { request(sessionId: string, role: SessionRole): string }
  liveNote(sessionId: string): { id: string; content: string } | undefined
}

/** The hook state of a running service; the store reads it does are synchronous. */
export function createHookState(deps: HookStateDeps): HookState {
  return {
    isSuperagentSession: (sessionId) => deps.registry.owner(sessionId) !== undefined,
    promptSections(sessionId) {
      const owner = deps.registry.owner(sessionId)
      if (!owner || owner.child || deps.unavailable() !== undefined) return { stable: [] }
      const note = deps.liveNote(sessionId)
      return {
        stable: [
          { id: 'superagent:policy', order: 180, content: deps.prompt.request(sessionId, owner.role) },
        ],
        ...(note ? { liveNote: note } : {}),
      }
    },
    guardTool({ sessionId, toolName, input }) {
      const owner = deps.registry.owner(sessionId)
      if (!owner) return undefined
      const unavailable = deps.unavailable()
      if (unavailable !== undefined) return unavailable
      if (owner.role.kind === 'worker') {
        const ticket = deps.store.tickets.get(owner.role.ticketId)
        return !ticket || !liveTicket(ticket) ? ENDED : undefined
      }
      return owner.child ? undefined : noWait(toolName, input)
    },
  }
}

/** Registers both hooks on the plugin row; they read `cell` only. */
export function registerHooks(
  plugin: Pick<PluginContextFacets, 'hooks'>,
  cell: HookStateCell,
): (() => void)[] {
  return [
    plugin.hooks.register('context', (_payload, ctx) => {
      const state = cell.get()
      if (!state.isSuperagentSession(ctx.session.key)) return {}
      const { stable, liveNote } = state.promptSections(ctx.session.key)
      if (!stable.length && !liveNote) return {}
      const sections: PromptSection[] = [...stable]
      if (liveNote)
        sections.push({
          id: 'superagent-notices',
          order: 181,
          content: liveNote.content,
          delivery: 'live-note',
        })
      return { refreshOnRequest: true, sections }
    }),
    plugin.hooks.register('tool_call', (payload, ctx) => {
      const state = cell.get()
      if (!state.isSuperagentSession(ctx.session.key)) return { allow: true }
      const reason = state.guardTool({
        sessionId: ctx.session.key,
        toolName: payload.name,
        input: payload.args,
      })
      return reason === undefined ? { allow: true } : { allow: false, reason }
    }),
  ]
}
