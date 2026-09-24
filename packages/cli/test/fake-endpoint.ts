import { type HarnessMeta, setHarnessMeta } from '@agnes/protocol'
import type { JsonRpcMessage, JsonRpcNotification, RpcEndpoint } from '@agnes/sdk'

type Handler = (params: unknown, ep: FakeEndpoint) => unknown | Promise<unknown>

/**
 * A daemon-shaped endpoint with no daemon behind it. It satisfies sdk's inproc transport contract,
 * which is the same three members daemon's own RpcEndpoint declares, so the client under test takes
 * the same code path it takes against the real thing.
 *
 * Everything a mode is meant to do -- prompt, read events, exit on a reason -- can be driven from
 * here, which is what lets this batch stop before bootLocal without leaving those paths untested.
 */
export class FakeEndpoint implements RpcEndpoint {
  readonly calls: Array<{ method: string; params: unknown }> = []
  private readonly handlers = new Map<string, Handler>()
  private queue: JsonRpcMessage[] = []
  private readonly waiters: Array<(m: JsonRpcMessage | null) => void> = []
  closed = false

  on(method: string, h: Handler): this {
    this.handlers.set(method, h)
    return this
  }

  push(notification: JsonRpcNotification): void {
    if (this.closed) return
    const w = this.waiters.shift()
    if (w) w(notification)
    else this.queue.push(notification)
  }

  // The harness meta rides inside `params`, not on the envelope: sdk hands the notification's params
  // to getHarnessMeta, and a session drops every row whose meta it cannot find there.
  pushEvent(sessionId: string, event: Record<string, unknown>, meta: HarnessMeta): void {
    this.push({
      jsonrpc: '2.0',
      method: '_agnes/v1/session.event',
      params: setHarnessMeta({ sessionId, event }, meta),
    })
  }

  pushNotice(payload: Record<string, unknown>): void {
    this.push({ jsonrpc: '2.0', method: '_agnes/v1/daemon.notice', params: payload })
  }

  // biome-ignore lint/suspicious/noConfusingVoidType: the seam is declared with `| void` in sdk, and a fixture that narrows it to `| undefined` stops standing in for the real endpoint
  async handle(msg: JsonRpcMessage): Promise<JsonRpcMessage | void> {
    const req = msg as { method?: string; params?: unknown; id?: string | number }
    const method = String(req.method)
    this.calls.push({ method, params: req.params })
    if (req.id === undefined) return
    let h = this.handlers.get(method)
    // Migration bridge for fixtures which only care about a small projected timeline. Production
    // never falls back to the unbounded endpoint: the fake wraps an explicitly registered legacy
    // handler in the new bounded-opening envelope so existing mode tests keep exercising their
    // intended behaviour while focused windowing tests register projectUIOpening themselves.
    if (!h && method === '_agnes/v1/session.projectUIOpening') {
      const legacy = this.handlers.get('_agnes/v1/session.projectUI')
      if (legacy) {
        h = async (params, endpoint) => {
          const requested = params as { sessionId?: string; maxNodes?: number }
          const legacyTimeline = (await legacy(params, endpoint)) as {
            sessionId?: string
            nodes?: unknown[]
          }
          const allNodes = legacyTimeline.nodes ?? []
          const totalNodes = allNodes.length
          const maxNodes = requested.maxNodes ?? 200
          const startIndex = Math.max(0, totalNodes - maxNodes)
          const timeline = {
            ...legacyTimeline,
            ...(requested.sessionId === undefined ? {} : { sessionId: requested.sessionId }),
            nodes: allNodes.slice(startIndex),
          }
          return {
            timeline,
            history:
              startIndex > 0
                ? { hasEarlier: true, cursor: `fake-history:${startIndex}`, startIndex, totalNodes }
                : { hasEarlier: false, startIndex, totalNodes },
          }
        }
      }
    }
    if (!h && method === '_agnes/v1/workspace.add') {
      h = (params) => {
        const path = (params as { path: string }).path
        return {
          workspace: {
            path,
            name: path.split('/').filter(Boolean).at(-1) ?? path,
            lastUsedAt: null,
            sessionCount: 0,
            available: true,
          },
        }
      }
    }
    if (!h && method === '_agnes/v1/workspace.list') h = () => ({ items: [] })
    if (!h)
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32601, message: 'METHOD_NOT_FOUND', data: { code: 'METHOD_NOT_FOUND' } },
      }
    try {
      return { jsonrpc: '2.0', id: req.id, result: await h(req.params, this) }
    } catch (e) {
      const err = e as { code?: number; message: string; data?: { code: string } & Record<string, unknown> }
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: {
          code: err.code ?? -32603,
          message: err.message,
          data: err.data ?? { code: 'INTERNAL' },
        },
      }
    }
  }

  get notifications(): AsyncIterable<JsonRpcMessage> {
    const self = this
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<JsonRpcMessage>> {
            const queued = self.queue.shift()
            if (queued) return Promise.resolve({ done: false, value: queued })
            if (self.closed) return Promise.resolve({ done: true, value: undefined as never })
            return new Promise((resolve) => {
              self.waiters.push((m) =>
                resolve(m ? { done: false, value: m } : { done: true, value: undefined as never }),
              )
            })
          },
        }
      },
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.queue = []
    // Woken with null rather than a synthetic message: the iterator has to end, and handing a
    // consumer one more frame on the way out is how a closed stream turns into an extra event.
    for (const w of this.waiters.splice(0)) w(null)
  }
}

const ACTOR = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
export const FAKE_SESSION_ID = 'agnes:local:default:cli:dm:main'

/**
 * Pushes the rows a moment after the caller has its answer. The two directions race in the real
 * endpoint -- a response comes back from handle() while every row travels the notification queue --
 * and this is the order the other one cannot be mistaken for: a consumer that only starts reading
 * after the reply still gets the rows, so a reader relying on having missed them fails here.
 */
const later = (fn: () => void): void => {
  setTimeout(fn, 0)
}

/**
 * The smallest endpoint that answers a whole one-shot run: handshake, apis.list, session/new,
 * attach, and one prompt that produces a turn/start, an assistant message and a turn/end.
 */
export function scriptedEndpoint(
  opts: {
    reply?: string
    reason?: string
    history?: string
    parkedTicket?: string
    /** Holds this turn's rows back a tick, so a replay scheduled earlier is delivered ahead of them. */
    slowRows?: boolean
    /**
     * Sends this turn's rows only after the prompt reply has gone back. A real endpoint can produce
     * this: the reply returns from handle() while every row travels the notification queue, and
     * daemon's own wait for quiescence is bounded, so a slow tail loses the race. Under it sdk has
     * no terminal notification to read when it answers and falls back to the ACP stop reason, which
     * calls a parked or blocked turn `end_turn`. Anything that reads the reason off the reply alone
     * gets the wrong exit code here.
     */
    rowsAfterReply?: boolean
    /** Emits one tool/call, effect/intent and effect/settled row before the assistant's reply. */
    toolCall?: { toolUseId: string; name: string; durationMs?: number; outcome?: 'ok' | 'error' | 'aborted' }
    /** The `error` a failed turn's turn/end row carries. */
    turnEndError?: { code: string; message: string }
  } = {},
): FakeEndpoint {
  const reply = opts.reply ?? 'hello from fake'
  const reason = opts.reason ?? 'completed'
  let seq = 0
  let ulid = 0
  const ev = (type: string, data: unknown): Record<string, unknown> => ({
    seq: ++seq,
    ts: new Date(0).toISOString(),
    id: `01J6ZM2Q3R4S5T6V7W8X9Y0${String(ulid++).padStart(3, '0')}`,
    type,
    data,
    actor: ACTOR,
    origin: 'model',
    trust: 'trusted',
  })
  const meta = (phase: HarnessMeta['phase'], turnEnd?: HarnessMeta['turnEnd']): HarnessMeta => ({
    promptTurnId: '1',
    eventSequence: seq,
    generation: 1,
    lane: 'main',
    phase,
    ...(turnEnd ? { turnEnd } : {}),
  })
  // A turn that already happened, minted eagerly so `seq` is where a real session's would be by the
  // time attach reports lastSeq. Replayed on attach, exactly as daemon replays from the cursor, so a
  // resume test sees the history it has to skip past rather than a stream that starts empty.
  const history: Array<{ event: Record<string, unknown>; meta: HarnessMeta }> = []
  if (opts.history !== undefined) {
    history.push({ event: ev('turn/start', { turn: 1, trigger: 'prompt' }), meta: meta('event') })
    history.push({
      event: ev('assistant/message', {
        content: [{ type: 'text', text: opts.history }],
        stopReason: 'end_turn',
      }),
      meta: meta('responseBoundary'),
    })
    history.push({
      event: ev('turn/end', { reason: 'completed', lastAssistantSeq: seq }),
      meta: meta('terminalQuiescence', { reason: 'completed' }),
    })
  }
  return new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('_agnes/v1/apis.list', () => ({
      profile: {
        name: 'local-dev',
        resolvedProfileHash: 'h',
        presets: { default: 'standard', allowed: ['standard'] },
      },
      families: [],
    }))
    .on('session/new', () => ({ sessionId: FAKE_SESSION_ID }))
    .on('session/load', () => ({}))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.attach', (_p, ep) => {
      const lastSeq = seq
      later(() => {
        for (const h of history) ep.pushEvent(FAKE_SESSION_ID, h.event, h.meta)
      })
      return { generation: 1, lastSeq, resolvedProfileHash: 'h' }
    })
    .on('session/prompt', async (_p, ep) => {
      if (opts.slowRows) await new Promise((r) => setTimeout(r, 5))
      const rows = (): void => {
        ep.pushEvent(FAKE_SESSION_ID, ev('turn/start', { turn: 1, trigger: 'prompt' }), meta('event'))
        if (opts.toolCall) {
          const { toolUseId, name, durationMs, outcome } = opts.toolCall
          const effectId = `effect-${toolUseId}`
          ep.pushEvent(
            FAKE_SESSION_ID,
            ev('tool/call', { toolUseId, name, args: {}, ordinal: 0 }),
            meta('event'),
          )
          ep.pushEvent(
            FAKE_SESSION_ID,
            ev('effect/intent', { effectId, kind: 'tool', tool: { toolUseId, name }, replay: 'safe' }),
            meta('event'),
          )
          ep.pushEvent(
            FAKE_SESSION_ID,
            ev('effect/settled', {
              effectId,
              outcome: outcome ?? 'ok',
              ...(durationMs !== undefined ? { durationMs } : {}),
            }),
            meta('event'),
          )
        }
        ep.pushEvent(
          FAKE_SESSION_ID,
          ev('assistant/message', { content: [{ type: 'text', text: reply }], stopReason: 'end_turn' }),
          meta('responseBoundary'),
        )
        if (opts.parkedTicket !== undefined)
          ep.pushEvent(
            FAKE_SESSION_ID,
            // A full row: protocol validates approval/asked data now, and the sdk drops a row it
            // cannot validate, which would take the ticket with it.
            ev('approval/asked', {
              requestId: 'req-1',
              kind: 'tool',
              risk: 'destructive',
              summary: 'rm -rf /tmp/x',
              bindingHash: 'b'.repeat(64),
              pending: { ticket: opts.parkedTicket, expiresAt: new Date(0).toISOString() },
            }),
            meta('event'),
          )
        const end = ev('turn/end', {
          reason,
          lastAssistantSeq: seq,
          ...(opts.turnEndError ? { error: opts.turnEndError } : {}),
        })
        ep.pushEvent(FAKE_SESSION_ID, end, meta('terminalQuiescence', { reason } as HarnessMeta['turnEnd']))
      }
      if (opts.rowsAfterReply) later(rows)
      else rows()
      // No pause before answering. The queue wakes a parked reader by resolving its promise, and
      // those microtasks are queued ahead of the one the transport uses to deliver this reply, so
      // the rows are already with the client. The pause that used to be here claimed to buy that
      // ordering and bought nothing: removing it turned no test red.
      return setHarnessMeta(
        { stopReason: 'end_turn' },
        meta('terminalQuiescence', { reason } as HarnessMeta['turnEnd']),
      )
    })
}
