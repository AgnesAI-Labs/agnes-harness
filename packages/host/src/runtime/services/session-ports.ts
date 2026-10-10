import { scanPages } from '@agnes/core'
import type { OwnerLedgerPort } from '@agnes/extension-api'
import {
  createOwnerLedger,
  type LedgerEvent,
  type OwnerLedgerSource,
} from '@agnes/host-common/assemble/owner-ledger'
import type { ServiceDelivery } from '@agnes/host-common/assemble/service-binding'
import { enqueueSessionInputOnce } from '../sessions/deferred-invocations.js'
import type { Actor, JsonValue } from '@agnes/protocol'

/** The session fields the shared ports read. HostSession satisfies this at the call site. */
export interface SessionLedgerSession {
  readonly lane: string
  readonly lastSeq: number
  readonly closingOrClosed: boolean
  readonly d: {
    readonly cwd: string
    readonly log: { readonly parent?: { readonly boundarySeq?: number } }
    readonly loopFactory: { readonly controls?: { readonly steer?: boolean } }
  }
  scan(query: { fromSeq?: number; toSeq?: number; lane?: string; limit?: number }): Promise<LedgerEvent[]>
  appendExtensionEvent(
    type: string,
    data: unknown,
    meta: { source: string; trust: 'builtin' | 'trusted' },
    sourceSeq?: number,
  ): Promise<number>
  op(): unknown
  enqueue(
    target: 'next-turn' | 'next-step',
    message: {
      content: { type: 'text'; text: string }[]
      actor: Actor
      commandId: string
      kind: 'follow_up'
      trust: 'untrusted'
      origin: 'system'
    },
  ): Promise<number>
}

export function sessionInputTarget(
  session: { op(): unknown; d: { loopFactory: { controls?: { steer?: boolean } } } },
  delivery: ServiceDelivery,
): 'next-turn' | 'next-step' {
  return delivery === 'follow-steer' && session.op() && session.d.loopFactory.controls?.steer
    ? 'next-step'
    : 'next-turn'
}

export function createSessionLedger(
  session: SessionLedgerSession,
  input: {
    kind: string
    owner: string
    eventNames: readonly string[]
    watermark: number
    trust: 'builtin' | 'trusted'
    alive: () => void
  },
): OwnerLedgerPort {
  const source: OwnerLedgerSource = {
    alive: input.alive,
    get boundarySeq() {
      return session.d.log.parent?.boundarySeq ?? 0
    },
    get lane() {
      return session.lane
    },
    scan(fromSeq, toSeq, lane) {
      return scanPages((query) => session.scan(query), { fromSeq, toSeq, lane })
    },
    append(type: string, data: JsonValue, sourceSeq?: number) {
      return session.appendExtensionEvent(type, data, { source: input.owner, trust: input.trust }, sourceSeq)
    },
  }
  return createOwnerLedger({
    kind: input.kind,
    owner: input.owner,
    eventNames: input.eventNames,
    watermark: input.watermark,
    source,
  })
}

export function createSessionAgentInput(
  session: SessionLedgerSession,
  actor: Actor,
  delivery: ServiceDelivery,
): (key: string, text: string, signal: AbortSignal) => Promise<number> {
  return (key, text, signal) =>
    enqueueSessionInputOnce(
      // enqueue reads scan, lane, lastSeq, and enqueue. The rest of HostSession stays on the caller.
      session as never,
      key,
      text,
      actor,
      signal,
      sessionInputTarget(session, delivery),
    )
}
