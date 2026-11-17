import type { Disposer, Seq, SessionRef } from './common.js'
import type { ProjectionReader } from './projections.js'
import type { SideCallPort } from './side-call.js'

/** Public text only. Host attests provenance and redacts complete text before copying it. */
export type SessionWorkMessage = Readonly<{
  role: 'user' | 'assistant'
  origin: 'principal' | 'system' | 'model'
  attribution: 'operator' | 'agent' | 'system'
  kind?: 'prompt' | 'steer' | 'follow_up' | 'runtime_context'
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'error'
  text: string
  thinking?: string
}>

/** Ordered, volatile observations; registering never replays old messages. */
export type SessionWorkObservation = Readonly<{
  session: SessionRef
  seq: Seq
  hasGeneratedTitle: boolean
}> &
  (Readonly<{ kind: 'message'; message: SessionWorkMessage }> | Readonly<{ kind: 'reset' | 'close' }>)

export type SessionWorkBoundary = Readonly<{
  turn: number
  startSeq: Seq
  endSeq: Seq
  lastAssistantSeq: Seq
}>

export type AutoTitleInspection =
  | Readonly<{ eligible: true; title: string; revision: Seq }>
  | Readonly<{
      eligible: false
      reason: 'no-title' | 'explicit-title' | 'unavailable' | 'closed' | 'budget'
    }>

export type AutoTitleRefreshResult = Readonly<{
  status: 'applied' | 'unchanged' | 'stale' | 'ineligible' | 'unavailable'
}>

/** Only Host generates and accepts titles. Context is redacted conversation data, not a title. */
export interface SessionWorkTitlePort {
  inspect(): Promise<AutoTitleInspection>
  refresh(input: Readonly<{ expectedRevision: Seq; context: string }>): Promise<AutoTitleRefreshResult>
}

/** Fresh invocation authority bound to its completed source turn, independent of later turns. */
export interface SessionWorkContext {
  readonly session: SessionRef
  readonly signal: AbortSignal
  readonly boundary: SessionWorkBoundary
  readonly sideCall: SideCallPort
  readonly projections: ProjectionReader
  /** Independently granted; background execution alone does not grant title mutation. */
  readonly title?: SessionWorkTitlePort
}

export interface SessionWorkRegistration {
  readonly name: string
  /** Pure observation. No invocation authority is supplied to this callback. */
  observe(observation: SessionWorkObservation): void
  /** At most one live callback per registration/session. Completion never drains pending work. */
  run(context: SessionWorkContext): Promise<void>
}

export interface PluginSessionWorkPort {
  /** Bound to this exact live plugin row and its sessions; callers cannot select another session. */
  register(registration: SessionWorkRegistration): Disposer
}
