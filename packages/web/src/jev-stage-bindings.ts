import type { SessionModelSlotsResult } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import type { StageBindings, StageName } from '@agnes/web-ui'

const STAGES: readonly StageName[] = ['parameters', 'arbitration', 'answer']
const empty = (): StageBindings => ({ parameters: null, arbitration: null, answer: null })
const same = (left: StageBindings[StageName], right: StageBindings[StageName]) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

/**
 * JevLoop per-stage model bindings behind the composer's model settings dialog. A draft holds the
 * bindings chosen before the session exists and is written once the session is created, ahead of
 * its first prompt; an existing session reads its live bindings lazily from session.modelSlots and
 * writes only the stages that changed through the authorized session.setJevStages.
 */
export class JevStageBindings {
  private draft = empty()
  private live: { sessionId: string; value: StageBindings } | undefined
  private loading: string | undefined
  // A failed read is not retried on every render; a session switch or a write clears it.
  private failed: string | undefined

  constructor(
    private readonly client: Pick<Client, 'call'>,
    private readonly changed: () => void,
  ) {}

  /** Bindings to show, or undefined while an existing session's state is still unread. */
  value(sessionId: string | undefined): StageBindings | undefined {
    if (sessionId === undefined) return this.draft
    if (this.live?.sessionId === sessionId) return this.live.value
    if (this.loading !== sessionId && this.failed !== sessionId) void this.load(sessionId)
    return undefined
  }

  /** Apply edited bindings: a draft is stored, a session gets one write of the changed stages. */
  async apply(sessionId: string | undefined, next: StageBindings): Promise<boolean> {
    if (sessionId === undefined) {
      this.draft = { ...next }
      return true
    }
    const current = this.live?.sessionId === sessionId ? this.live.value : undefined
    if (!current) return false
    const changed = Object.fromEntries(
      STAGES.filter((stage) => !same(current[stage], next[stage])).map((stage) => [stage, next[stage]]),
    )
    if (Object.keys(changed).length === 0) return true
    await this.client.call('_agnes/v1/session.setJevStages', { sessionId, stages: changed })
    this.failed = undefined
    this.live = { sessionId, value: { ...next } }
    return true
  }

  /** Write the draft to a just-created session before its first prompt, then start a fresh draft. */
  async flush(sessionId: string): Promise<void> {
    const stages = Object.fromEntries(
      STAGES.filter((stage) => this.draft[stage]).map((stage) => [stage, this.draft[stage]]),
    )
    const value = this.draft
    this.draft = empty()
    if (Object.keys(stages).length)
      await this.client.call('_agnes/v1/session.setJevStages', { sessionId, stages })
    this.live = { sessionId, value }
  }

  private async load(sessionId: string): Promise<void> {
    this.loading = sessionId
    try {
      const result = await this.client.call<SessionModelSlotsResult>('_agnes/v1/session.modelSlots', {
        sessionId,
      })
      if (result.sessionId !== sessionId) return
      const bindings = result.languageBindings
      this.live = {
        sessionId,
        value: {
          parameters: bindings?.parameters ?? null,
          arbitration: bindings?.arbitration ?? null,
          answer: bindings?.answer ?? null,
        },
      }
      this.changed()
    } catch {
      this.failed = sessionId
    } finally {
      if (this.loading === sessionId) this.loading = undefined
    }
  }
}
