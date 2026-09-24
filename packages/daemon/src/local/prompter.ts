import type { Prompter } from '@agnes/host'
import {
  type AcpPermissionKind,
  type ApprovalVerdict,
  fromAcpOptionKind,
  OFFERED_OPTION_KINDS,
} from '@agnes/protocol'
import type { ConnectionState, LocalEndpoint } from './endpoint.js'

// The request shape is core's, reached through the signature host publishes: one source, so the two
// cannot drift. When the shape moves to protocol this becomes an import from there.
export type ApprovalRequest = Parameters<Prompter['ask']>[0]
export type { Prompter }

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

  private done(requestId: string, via: AskOutcome['via'], verdict: ApprovalVerdict): ApprovalVerdict {
    this.o.record?.({ requestId, via, verdict })
    return verdict
  }

  async ask(req: ApprovalRequest, opts: { signal: AbortSignal }): Promise<ApprovalVerdict> {
    if (this.o.local) return this.done(req.requestId, 'local', await this.o.local.ask(req, opts))
    const origin = this.o.originOf(req.sessionKey)
    const candidates = [
      origin,
      ...this.o.connections().filter((c) => c !== origin && c.attached.has(req.sessionKey)),
    ].filter((c): c is ConnectionState => !!c && c.capabilities.permission)
    // 'unavailable' hands control to the preset's on_unavailable, so it is reserved for the one case
    // where nothing was asked. Every path below has put the question on the wire.
    const target = candidates[0]
    if (!target) return this.done(req.requestId, 'absent', 'unavailable')
    const params = {
      sessionId: req.sessionKey,
      toolCall: {
        toolCallId: req.toolUseId ?? req.requestId,
        title: req.summary,
        ...(req.tool ? { rawInput: structuredClone(req.tool.args) } : {}),
        kind: req.kind === 'tool' ? 'execute' : 'other',
        status: 'pending',
      },
      // This request is ACP. Its allow_always is session-scoped and must never be upgraded into
      // Agnes' distinct profile-scoped permanent verdict.
      options: OFFERED_OPTION_KINDS.map((k) => ({ optionId: k, name: k, kind: k })),
      _meta: { 'ai.agnes.harness': { deadline: req.deadline, requestId: req.requestId } },
    }
    const deadlineMs = Date.parse(req.deadline) - this.o.clock()
    let res: unknown
    try {
      // The endpoint comes from the connection that was chosen, not from a fixed one: otherwise the
      // capability filter decides nothing and the question goes to whoever the caller wired in.
      res = await this.o.endpointFor(target).request('session/request_permission', params, {
        signal: opts.signal,
        ...(Number.isFinite(deadlineMs) && deadlineMs > 0 ? { timeoutMs: deadlineMs } : {}),
      })
    } catch (e) {
      if (opts.signal.aborted) return this.done(req.requestId, 'aborted', 'cancelled')
      // A timeout, a transport fault and a client-side JSON-RPC error all fail closed. Turning any of
      // them into 'unavailable' would let an outage pick up whatever on_unavailable allows.
      return this.done(req.requestId, causeOf(e), 'rejected')
    }
    const outcome = (res as { outcome?: { outcome?: unknown; optionId?: unknown } } | undefined)?.outcome
    if (outcome?.outcome === 'cancelled') return this.done(req.requestId, 'answered', 'cancelled')
    if (
      outcome?.outcome === 'selected' &&
      typeof outcome.optionId === 'string' &&
      OPTION_IDS.has(outcome.optionId)
    )
      return this.done(req.requestId, 'answered', fromAcpOptionKind(outcome.optionId as AcpPermissionKind))
    return this.done(req.requestId, 'malformed', 'rejected')
  }
}
