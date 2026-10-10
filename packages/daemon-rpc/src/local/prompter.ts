import type { ConnectionState, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { Prompter } from '@agnes/host'
import {
  type AcpPermissionKind,
  type ApprovalVerdict,
  fromAcpOptionKind,
  OFFERED_OPTION_KINDS,
} from '@agnes/protocol'
import { toolKind } from './project.js'

// The request shape is core's, reached through the signature host publishes: one source, so the two
// cannot drift. When the shape moves to protocol this becomes an import from there.
export type ApprovalRequest = Parameters<Prompter['ask']>[0]
export type { Prompter }
/** What a prompter hands back: a bare verdict, or a verdict with the reason behind it. */
export type PrompterAnswer = Awaited<ReturnType<Prompter['ask']>>
const verdictOf = (answer: PrompterAnswer): ApprovalVerdict =>
  typeof answer === 'string' ? answer : answer.verdict

export type AskOutcome = {
  requestId: string
  via: 'local' | 'absent' | 'answered' | 'aborted' | 'timeout' | 'transport' | 'malformed'
  verdict: ApprovalVerdict
}

const OPTION_IDS = new Set<string>(OFFERED_OPTION_KINDS)

const RETRY_WAIT_MS = 20

const errorCode = (e: unknown): string | undefined => {
  const code = (e as { data?: { code?: unknown } } | undefined)?.data?.code
  return typeof code === 'string' ? code : undefined
}

const causeOf = (e: unknown): 'timeout' | 'transport' =>
  errorCode(e) === 'TIMEOUT' ? 'timeout' : 'transport'

/** A dropped browser socket, not a decision. The same question can still be asked of another client. */
const disconnected = (e: unknown): boolean => errorCode(e) === 'CLOSED'

const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

export type PrompterRouterOptions = {
  local?: Prompter
  endpointFor: (conn: ConnectionState) => LocalEndpoint
  connections: () => ConnectionState[]
  originOf: (sessionKey: string) => ConnectionState | undefined
  clock: () => number
  record?: (r: AskOutcome) => void
}

export class PrompterRouter implements Prompter {
  constructor(private readonly o: PrompterRouterOptions) {}

  private done(requestId: string, via: AskOutcome['via'], answer: PrompterAnswer): PrompterAnswer {
    this.o.record?.({ requestId, via, verdict: verdictOf(answer) })
    return answer
  }

  /** For callers that only need to know whether the answer was a yes. */
  async askVerdict(req: ApprovalRequest, opts: { signal: AbortSignal }): Promise<ApprovalVerdict> {
    return verdictOf(await this.ask(req, opts))
  }

  async ask(req: ApprovalRequest, opts: { signal: AbortSignal }): Promise<PrompterAnswer> {
    if (this.o.local) return this.done(req.requestId, 'local', await this.o.local.ask(req, opts))
    const params = {
      sessionId: req.sessionKey,
      toolCall: {
        toolCallId: req.toolUseId ?? req.requestId,
        title: req.summary,
        ...(req.tool ? { rawInput: structuredClone(req.tool.args) } : {}),
        kind: req.kind === 'tool' ? toolKind(req.tool?.name) : 'other',
        status: 'pending',
        // The tool's name, so a client can say what "allow for the session" covers.
        ...(req.tool ? { _meta: { 'ai.agnes.harness': { tool: req.tool.name } } } : {}),
      },
      // This request is ACP. Its allow_always is session-scoped and must never be upgraded into
      // Agnes' distinct profile-scoped permanent verdict.
      options: OFFERED_OPTION_KINDS.map((k) => ({ optionId: k, name: k, kind: k })),
      _meta: { 'ai.agnes.harness': { deadline: req.deadline, requestId: req.requestId } },
    }
    const deadlineAt = Date.parse(req.deadline)
    // A refresh closes the socket that was holding the question. That connection is skipped so the
    // same approval is asked again, and is never recorded as a rejection of its own.
    const skipped = new Set<ConnectionState>()
    let asked = false
    while (true) {
      if (opts.signal.aborted)
        return this.done(req.requestId, 'aborted', { verdict: 'cancelled', reason: 'stopped' })
      const remaining = deadlineAt - this.o.clock()
      const expired = Number.isFinite(deadlineAt) && remaining <= 0
      if (expired && (asked || skipped.size > 0))
        return this.done(req.requestId, 'timeout', { verdict: 'rejected', reason: 'timeout' })
      const origin = this.o.originOf(req.sessionKey)
      const target = [
        origin,
        ...this.o.connections().filter((c) => c !== origin && c.attached.has(req.sessionKey)),
      ].filter((c): c is ConnectionState => !!c && c.capabilities.permission && !skipped.has(c))[0]
      // 'unavailable' hands control to the preset's on_unavailable, so it is reserved for the one case
      // where nothing was asked. A dropped connection is not that case: nobody has answered yet.
      if (!target) {
        if (!asked && skipped.size === 0) return this.done(req.requestId, 'absent', 'unavailable')
        await pause(
          Math.min(RETRY_WAIT_MS, Number.isFinite(remaining) ? Math.max(remaining, 1) : RETRY_WAIT_MS),
          opts.signal,
        )
        continue
      }
      let endpoint: LocalEndpoint
      try {
        // The endpoint comes from the connection that was chosen, not from a fixed one: otherwise the
        // capability filter decides nothing and the question goes to whoever the caller wired in.
        endpoint = this.o.endpointFor(target)
      } catch {
        skipped.add(target)
        continue
      }
      let res: unknown
      try {
        asked = true
        res = await endpoint.request('session/request_permission', params, {
          signal: opts.signal,
          ...(Number.isFinite(remaining) && remaining > 0 ? { timeoutMs: remaining } : {}),
        })
      } catch (e) {
        if (opts.signal.aborted)
          return this.done(req.requestId, 'aborted', { verdict: 'cancelled', reason: 'stopped' })
        // The browser refreshed. Keep the original question open for the next attached client until
        // the deadline. A timeout, any other transport fault, and a client JSON-RPC error still fail
        // closed: 'unavailable' would let an outage pick up whatever on_unavailable allows.
        if (disconnected(e)) {
          skipped.add(target)
          continue
        }
        const cause = causeOf(e)
        return this.done(
          req.requestId,
          cause,
          cause === 'timeout' ? { verdict: 'rejected', reason: 'timeout' } : 'rejected',
        )
      }
      const outcome = (res as { outcome?: { outcome?: unknown; optionId?: unknown } } | undefined)?.outcome
      if (outcome?.outcome === 'cancelled') return this.done(req.requestId, 'answered', 'cancelled')
      if (
        outcome?.outcome === 'selected' &&
        typeof outcome.optionId === 'string' &&
        OPTION_IDS.has(outcome.optionId)
      ) {
        const verdict = fromAcpOptionKind(outcome.optionId as AcpPermissionKind)
        return this.done(
          req.requestId,
          'answered',
          verdict === 'rejected' ? { verdict, reason: 'user_rejected' } : verdict,
        )
      }
      return this.done(req.requestId, 'malformed', 'rejected')
    }
  }
}
