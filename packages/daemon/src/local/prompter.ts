import type { Prompter } from '@agnes/host'
import {
  type AcpPermissionKind,
  type ApprovalVerdict,
  fromAcpOptionKind,
  OFFERED_OPTION_KINDS,
} from '@agnes/protocol'
import type { ConnectionState, LocalEndpoint } from './endpoint.js'
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

const causeOf = (e: unknown): 'timeout' | 'transport' => {
  const code = (e as { data?: { code?: unknown } } | undefined)?.data?.code
  return code === 'TIMEOUT' ? 'timeout' : 'transport'
}

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

  /**
   * Who to ask next: the connection that sent the prompt, then any other attached to the session.
   * Only live connections count. The origin is remembered until the prompt ends, and the turn outlives
   * the socket that started it: a client that reconnected mid-turn left the origin pointing at a
   * connection that was gone, asking it failed at once, and the call was refused before the
   * reconnected client ever saw the question.
   */
  private nextTarget(sessionKey: string, tried: ReadonlySet<ConnectionState>): ConnectionState | undefined {
    const live = this.o.connections()
    const origin = this.o.originOf(sessionKey)
    return [origin, ...live.filter((c) => c !== origin && c.attached.has(sessionKey))].find(
      (c): c is ConnectionState => !!c && live.includes(c) && !tried.has(c) && c.capabilities.permission,
    )
  }

  async ask(req: ApprovalRequest, opts: { signal: AbortSignal }): Promise<PrompterAnswer> {
    if (this.o.local) return this.done(req.requestId, 'local', await this.o.local.ask(req, opts))
    // 'unavailable' hands control to the preset's on_unavailable, so it is reserved for the one case
    // where there was nobody to ask. Every path below has tried to put the question on the wire.
    let target = this.nextTarget(req.sessionKey, new Set())
    if (!target) return this.done(req.requestId, 'absent', 'unavailable')
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
    const tried = new Set<ConnectionState>()
    let res: unknown
    for (;;) {
      tried.add(target)
      const deadlineMs = Date.parse(req.deadline) - this.o.clock()
      try {
        // The endpoint comes from the connection that was chosen, not from a fixed one: otherwise the
        // capability filter decides nothing and the question goes to whoever the caller wired in.
        res = await this.o.endpointFor(target).request('session/request_permission', params, {
          signal: opts.signal,
          ...(Number.isFinite(deadlineMs) && deadlineMs > 0 ? { timeoutMs: deadlineMs } : {}),
        })
        break
      } catch (e) {
        if (opts.signal.aborted)
          return this.done(req.requestId, 'aborted', { verdict: 'cancelled', reason: 'stopped' })
        // A timeout, a transport fault and a client-side JSON-RPC error all fail closed. Turning any of
        // them into 'unavailable' would let an outage pick up whatever on_unavailable allows.
        if (causeOf(e) === 'timeout')
          return this.done(req.requestId, 'timeout', { verdict: 'rejected', reason: 'timeout' })
        // A client that went away or could not take the question gave no answer, so another client
        // still attached to the session is asked within what is left of the same deadline. With none,
        // the refusal names the approver as what failed: the user decided nothing.
        const next = this.nextTarget(req.sessionKey, tried)
        const left = Date.parse(req.deadline) - this.o.clock()
        if (!next || (Number.isFinite(left) && left <= 0))
          return this.done(req.requestId, 'transport', { verdict: 'rejected', reason: 'approver_failed' })
        target = next
      }
    }
    const outcome = (res as { outcome?: { outcome?: unknown; optionId?: unknown } } | undefined)?.outcome
    // Every answer a client gives says who gave it: a choice is the user's, a cancellation is the
    // client withdrawing the question, and anything else is the approver failing.
    if (outcome?.outcome === 'cancelled')
      return this.done(req.requestId, 'answered', { verdict: 'cancelled', reason: 'client_cancelled' })
    if (
      outcome?.outcome === 'selected' &&
      typeof outcome.optionId === 'string' &&
      OPTION_IDS.has(outcome.optionId)
    ) {
      const verdict = fromAcpOptionKind(outcome.optionId as AcpPermissionKind)
      return this.done(req.requestId, 'answered', {
        verdict,
        reason: verdict === 'rejected' ? 'user_rejected' : 'user_allowed',
      })
    }
    return this.done(req.requestId, 'malformed', { verdict: 'rejected', reason: 'approver_failed' })
  }
}
