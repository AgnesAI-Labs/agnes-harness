import type { Actor, AssistantMessage, ContentBlock, EventEnvelope, JsonValue } from '@agnes/protocol'
import type { ImportSource } from './types.js'
import { ulidAt } from './ulid.js'

export const IMPORT_ACTOR: Actor = {
  id: 'import',
  org: 'local',
  role: 'importer',
  deptPath: [],
  attrs: {},
}

type BuilderOptions = {
  source: ImportSource
  sessionKey: string
  now: () => number
  rng: () => number
  agnesVersion: string
}

const timestamp = (candidate: string | undefined, fallback: number): { iso: string; ms: number } => {
  const parsed = candidate === undefined ? Number.NaN : Date.parse(candidate)
  const ms = Number.isFinite(parsed) ? parsed : fallback
  const safe = Number.isFinite(ms) && ms >= 0 && ms <= 8.64e15 ? ms : 0
  return { iso: new Date(safe).toISOString(), ms: safe }
}

export class EnvelopeBuilder {
  private readonly events: EventEnvelope[] = []
  private turn = 0
  private step = 0
  private turnOpen = false
  private stepOpen = false
  private stepHadTools = false
  private stepCallCount = 0
  private readonly pendingCalls = new Set<string>()
  private lastAssistantSeq: number | null = null
  private lastIdMs = -1

  constructor(private readonly options: BuilderOptions) {}

  get seq(): number {
    return this.events.length
  }

  private push(type: string, data: JsonValue, at?: string): EventEnvelope {
    const time = timestamp(at ?? this.events.at(-1)?.ts, this.options.now())
    const idMs = Math.max(time.ms, this.lastIdMs + 1)
    this.lastIdMs = idMs
    const event: EventEnvelope = {
      seq: this.events.length + 1,
      ts: time.iso,
      id: ulidAt(idMs, this.options.rng),
      type,
      data,
      actor: IMPORT_ACTOR,
      origin: `import:${this.options.source}`,
      trust: 'untrusted',
      lane: 'main',
      v: 1,
      ...(type.startsWith('x/') ? { ignorable: true as const } : {}),
    }
    this.events.push(event)
    return event
  }

  start(meta: { sourceId: string; cwd: string }): EventEnvelope {
    if (this.events.length > 0) throw new Error('session/start must be the first imported event')
    return this.push('session/start', {
      key: this.options.sessionKey.slice(0, 512),
      resolvedProfileHash: null,
      preset: null,
      agnesVersion: this.options.agnesVersion.slice(0, 64),
      imported: {
        source: this.options.source,
        sourceId: meta.sourceId.slice(0, 256),
        cwd: meta.cwd.slice(0, 4096),
      },
    })
  }

  private closeStep(at?: string): void {
    if (!this.stepOpen) return
    this.push('step/end', { turn: this.turn, step: this.step }, at)
    this.stepOpen = false
    this.stepHadTools = false
    this.stepCallCount = 0
    this.pendingCalls.clear()
  }

  private closeTurn(at?: string): void {
    if (!this.turnOpen) return
    this.closeStep(at)
    this.push('turn/end', { reason: 'completed', lastAssistantSeq: this.lastAssistantSeq }, at)
    this.turnOpen = false
    this.lastAssistantSeq = null
  }

  private ensureStep(at?: string): void {
    if (!this.turnOpen) {
      this.turn++
      this.step = 0
      this.push('turn/start', { turn: this.turn, trigger: 'prompt' }, at)
      this.turnOpen = true
    }
    if (!this.stepOpen) {
      this.step++
      this.push('step/start', { turn: this.turn, step: this.step }, at)
      this.stepOpen = true
    }
  }

  user(content: ContentBlock[], at?: string): EventEnvelope {
    this.closeTurn(at)
    this.turn++
    this.step = 0
    this.lastAssistantSeq = null
    this.push('turn/start', { turn: this.turn, trigger: 'prompt' }, at)
    this.turnOpen = true
    return this.push(
      'user/message',
      { content: content.length > 0 ? content : [{ type: 'text', text: '' }], kind: 'prompt' },
      at,
    )
  }

  assistant(
    content: AssistantMessage['content'],
    stopReason: AssistantMessage['stopReason'],
    at?: string,
  ): EventEnvelope {
    if (this.stepOpen && this.stepHadTools) this.closeStep(at)
    this.ensureStep(at)
    const event = this.push('assistant/message', { content, stopReason }, at)
    this.lastAssistantSeq = event.seq
    return event
  }

  toolCall(call: { toolUseId: string; name: string; args: unknown }, at?: string): EventEnvelope {
    this.ensureStep(at)
    const toolUseId = call.toolUseId.slice(0, 128)
    this.stepHadTools = true
    this.pendingCalls.add(toolUseId)
    return this.push(
      'tool/call',
      {
        toolUseId,
        name: call.name,
        args: call.args as JsonValue,
        ordinal: this.stepCallCount++,
      },
      at,
    )
  }

  toolResult(
    result: {
      toolUseId: string
      content: ContentBlock[]
      isError: boolean
      structured?: unknown
    },
    at?: string,
  ): boolean {
    const toolUseId = result.toolUseId.slice(0, 128)
    if (!this.stepOpen || !this.pendingCalls.delete(toolUseId)) return false
    this.push(
      'tool/result',
      {
        toolUseId,
        content: result.content,
        isError: result.isError,
        ...(result.structured !== undefined ? { structured: result.structured as JsonValue } : {}),
        enforcement: { level: 'none', scope: [] },
        authz: { decisionId: 'n/a' },
      },
      at,
    )
    return true
  }

  ext(name: string, data: unknown, at?: string): EventEnvelope {
    const safe = name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '')
    return this.push(`x/agnes/import/${safe || 'unmapped'}`.slice(0, 128), data as JsonValue, at)
  }

  finish(): EventEnvelope[] {
    this.closeTurn()
    return [...this.events]
  }
}
