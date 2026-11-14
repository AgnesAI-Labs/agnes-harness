import { createHash } from 'node:crypto'
import type { PluginProjectionDef } from '@agnes/extension-api'
import { object } from '../questions.js'
import { redactedWindow } from './redacted-window.js'

export const CONVERSATION = 'stop.conversation'
type Receipt = { id: string; token: string; commandId?: string; present: boolean; delivered: boolean }
export type ConversationState = {
  child: boolean
  request: { seq: number; text: string } | null
  reply: { seq: number; text: string; hasTools: boolean } | null
  continuedSeq: number
  goalSources: string[]
  queued: Receipt[]
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const textOf = (content: unknown) =>
  Array.isArray(content)
    ? content
        .flatMap((block) =>
          object(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
        )
        .join('\n')
    : ''

// Inbox reference excerpts become separate system/untrusted messages on delivery.
const humanTextOf = (content: unknown) =>
  textOf(
    Array.isArray(content) ? content.filter((block) => object(block) && block.reference === undefined) : [],
  )

/** Principal provenance, rather than text or a command id, establishes human input. */
function humanSource(actor: unknown, origin: unknown, trust: unknown, kind: unknown): string | null {
  if (
    origin !== 'principal' ||
    trust !== 'trusted' ||
    !['prompt', 'steer'].includes(String(kind)) ||
    !object(actor) ||
    typeof actor.id !== 'string' ||
    typeof actor.role !== 'string' ||
    actor.role === 'extension'
  )
    return null
  return hash([
    actor.id,
    actor.org,
    actor.role,
    actor.deptPath,
    object(actor.attrs) ? Object.entries(actor.attrs).sort(([a], [b]) => a.localeCompare(b)) : [],
  ])
}
function goal(sources: string[], source: string, text: string): string[] {
  if (!/^\/goal(?:\s|$)/.test(text)) return sources
  const command = text.slice(5).trim()
  if (!command || command === 'show') return sources
  if (command === 'clear') return sources.filter((value) => value !== source)
  return sources.includes(source) ? sources : [...sources, source]
}

/** The registry requires unchanged reducer content to retain its original object identity. */
function retainUnchanged(state: ConversationState, next: ConversationState): ConversationState {
  const same =
    state.child === next.child &&
    state.continuedSeq === next.continuedSeq &&
    state.request?.seq === next.request?.seq &&
    state.request?.text === next.request?.text &&
    state.reply?.seq === next.reply?.seq &&
    state.reply?.text === next.reply?.text &&
    state.reply?.hasTools === next.reply?.hasTools &&
    state.goalSources.length === next.goalSources.length &&
    state.goalSources.every((source, index) => source === next.goalSources[index]) &&
    state.queued.length === next.queued.length &&
    state.queued.every((item, index) => {
      const other = next.queued[index]
      return (
        other !== undefined &&
        item.id === other.id &&
        item.token === other.token &&
        item.commandId === other.commandId &&
        item.present === other.present &&
        item.delivered === other.delivered
      )
    })
  return same ? state : next
}

export function createConversationProjection(owner: string): PluginProjectionDef<ConversationState> {
  const marker = `x/${owner}/stop.continued`
  return {
    name: CONVERSATION,
    stateVersion: 3,
    inputEventTypes: ['session/start', 'user/message', 'assistant/message', 'inbox', marker],
    maxStateBytes: 262144,
    stateSchema: {
      type: 'object',
      required: ['child', 'request', 'reply', 'continuedSeq', 'goalSources', 'queued'],
      additionalProperties: false,
      properties: {
        child: { type: 'boolean' },
        request: {},
        reply: {},
        continuedSeq: { type: 'integer', minimum: 0 },
        goalSources: { type: 'array', items: { type: 'string' } },
        queued: { type: 'array' },
      },
    },
    init: () => ({ child: false, request: null, reply: null, continuedSeq: 0, goalSources: [], queued: [] }),
    apply(state, event) {
      const data = event.data
      if (
        event.type === 'session/start' &&
        event.origin === 'system' &&
        event.trust === 'trusted' &&
        object(data)
      )
        return retainUnchanged(state, {
          ...state,
          child: ['parent', 'delegation', 'fork'].some((key) => Object.hasOwn(data, key)),
        })
      if (
        event.type === marker &&
        (event.origin === `ext:${owner}` || event.origin === 'system') &&
        object(data) &&
        Number.isSafeInteger(data.requestSeq) &&
        Number(data.requestSeq) > 0
      )
        return retainUnchanged(state, {
          ...state,
          continuedSeq: Math.max(state.continuedSeq, Number(data.requestSeq)),
        })
      if (event.type === 'inbox' && event.origin === 'system' && event.trust === 'trusted') {
        let goalSources = state.goalSources
        const queued = state.queued.map((item) => ({ ...item, present: false }))
        const items = object(data) && Array.isArray(data.items) ? data.items : []
        for (const item of items) {
          if (!object(item)) continue
          const source = humanSource(
            item.actor,
            item.origin ?? 'principal',
            item.trust ?? 'trusted',
            item.kind,
          )
          const text = humanTextOf(item.content).trim()
          if (!source || !/^\/goal(?:\s|$)/.test(text) || typeof item.itemId !== 'string') continue
          const seen = queued.find((receipt) => receipt.id === item.itemId)
          if (seen) {
            seen.present = true
            continue
          }
          goalSources = goal(goalSources, source, text)
          queued.push({
            id: item.itemId,
            token: hash([source, text]),
            present: true,
            delivered: false,
            ...(typeof item.commandId === 'string' && item.commandId ? { commandId: item.commandId } : {}),
          })
        }
        // A drain is recorded before delivery: retain undelivered receipts so an old command
        // cannot undo a later clear when it subsequently appears as user/message.
        return retainUnchanged(state, {
          ...state,
          goalSources,
          queued: queued.filter((item) => item.present || !item.delivered),
        })
      }
      if (!object(data)) return state
      if (event.type === 'user/message') {
        const source = humanSource(event.actor, event.origin, event.trust, data.kind ?? 'prompt')
        if (!source) return state
        const text = humanTextOf(data.content)
        const token = hash([source, text.trim()])
        const commandId = typeof data.commandId === 'string' && data.commandId ? data.commandId : undefined
        let consumed = false
        const queued = state.queued
          .map((item) => {
            // Only legacy receipt + legacy delivery may match without a command identity.
            if (consumed || item.delivered || item.token !== token || item.commandId !== commandId)
              return item
            consumed = true
            return { ...item, delivered: true }
          })
          .filter((item) => item.present || !item.delivered)
        return retainUnchanged(state, {
          ...state,
          queued,
          goalSources: consumed ? state.goalSources : goal(state.goalSources, source, text.trim()),
          ...(data.kind === undefined || data.kind === 'prompt'
            ? { request: { seq: event.seq, text: redactedWindow(text, 2000, 'first') }, reply: null }
            : {}),
        })
      }
      if (event.type === 'assistant/message')
        return retainUnchanged(state, {
          ...state,
          reply: {
            seq: event.seq,
            text: redactedWindow(textOf(data.content), 8000, 'last'),
            hasTools: data.stopReason === 'tool_use',
          },
        })
      return state
    },
  }
}
