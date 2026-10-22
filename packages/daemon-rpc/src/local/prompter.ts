import { automaticRequestDecision, completeAutomaticDecision } from './permission-scope.js'

export {
  type AutomaticPermissionEvidence,
  acquirePermissionLease,
  assertCurrentPermission,
  assertPermissionBinding,
  currentPermissionContext,
  PermissionGrantUnavailable,
  withPermissionContext,
} from './permission-scope.js'

import { type ConnectionState, connActor, type LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { Prompter } from '@agnes/host'
import {
  type AcpPermissionKind,
  type Actor,
  type ApprovalReason,
  type ApprovalVerdict,
  fromAcpOptionKind,
  isPermissionPurpose,
  toAcpOptionKind,
  validateAgainst,
} from '@agnes/protocol'
import { Actor as ActorSchema } from '@agnes/protocol/gen/session-v1'
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
  via: 'full-access' | 'local' | 'absent' | 'answered' | 'aborted' | 'timeout' | 'transport' | 'malformed'
  verdict: ApprovalVerdict
  reason?: ApprovalReason
  answeredBy?: Actor
}

/** A configured bridge verifier must validate provider/user/event binding before returning an actor. */
export type SourceApprovalVerifier = (
  conn: ConnectionState,
  sourceCredential: unknown,
  sessionKey: string,
) => Promise<Actor>
export async function approvalActor(
  conn: ConnectionState,
  sessionKey: string,
  resolve?: (conn: ConnectionState, sessionKey: string) => Promise<Actor>,
  verifySource?: SourceApprovalVerifier,
  sourceCredential?: unknown,
): Promise<Actor> {
  if (sourceCredential !== undefined) {
    if (!verifySource || !['local', 'source-auth'].includes(conn.authKind ?? ''))
      throw new Error('unverified approval source')
    const actor = await verifySource(conn, sourceCredential, sessionKey)
    if (!validateAgainst(ActorSchema, actor).ok) throw new Error('invalid approval actor')
    return structuredClone(actor)
  }
  if (conn.credentialKind === 'channel' && conn.authKind !== 'source-auth')
    throw new Error('approval source proof required')
  const actor = resolve ? await resolve(conn, sessionKey) : connActor(conn)
  if (!validateAgainst(ActorSchema, actor).ok) throw new Error('invalid approval actor')
  return structuredClone(actor)
}

const errorCode = (e: unknown): string | undefined => {
  const code = (e as { data?: { code?: unknown } } | undefined)?.data?.code
  return typeof code === 'string' ? code : undefined
}

const causeOf = (e: unknown): 'timeout' | 'transport' =>
  errorCode(e) === 'TIMEOUT' ? 'timeout' : 'transport'

/** A dropped browser socket, not a decision. The same question can still be asked of another client. */
const disconnected = (e: unknown): boolean => errorCode(e) === 'CLOSED'

type ConnectionListener = (conn: ConnectionState) => void
const attachments = new Set<ConnectionListener>()
const subscribeAttachment = (listener: ConnectionListener): (() => void) => {
  attachments.add(listener)
  return () => {
    attachments.delete(listener)
  }
}

/** Transient wake-up only; the router rechecks the live, authorized connection set. */
export function notifyApprovalConnectionAttached(conn: ConnectionState): void {
  for (const listener of attachments) listener(conn)
}

export type PrompterRouterOptions = {
  /** Lifetime of an owning embedded endpoint; shared daemon routers omit it. */
  signal?: AbortSignal
  local?: Prompter
  localActor?: (sessionKey: string) => Promise<Actor>
  endpointFor: (conn: ConnectionState) => LocalEndpoint
  connections: () => ConnectionState[]
  originOf: (sessionKey: string) => ConnectionState | undefined
  clock: () => number
  resolveActor?: (conn: ConnectionState, sessionKey: string) => Promise<Actor>
  verifySource?: SourceApprovalVerifier
  record?: (r: AskOutcome) => void
}

export class PrompterRouter implements Prompter {
  constructor(private readonly o: PrompterRouterOptions) {}

  private waitForConnection(sessionKey: string, ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted || ms <= 0) {
        resolve()
        return
      }
      let unsubscribe = () => {}
      const finish = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        unsubscribe()
        resolve()
      }
      const timer = setTimeout(finish, Math.min(ms, 2_147_483_647))
      signal.addEventListener('abort', finish, { once: true })
      unsubscribe = subscribeAttachment((conn) => {
        if (
          conn.capabilities.permission &&
          (conn.attached.has(sessionKey) || this.o.originOf(sessionKey) === conn)
        )
          finish()
      })
      if (signal.aborted) finish()
    })
  }

  private done(requestId: string, via: AskOutcome['via'], answer: PrompterAnswer): PrompterAnswer {
    this.o.record?.({
      requestId,
      via,
      verdict: verdictOf(answer),
      ...(typeof answer === 'object' ? answer : {}),
    })
    return answer
  }

  /** For callers that only need to know whether the answer was a yes. */
  async askVerdict(req: ApprovalRequest, opts: { signal: AbortSignal }): Promise<ApprovalVerdict> {
    return verdictOf(await this.ask(req, opts))
  }

  async ask(req: ApprovalRequest, opts: { signal: AbortSignal }): Promise<PrompterAnswer> {
    req = structuredClone(req)
    const interrupted = () =>
      this.done(
        req.requestId,
        opts.signal.reason === 'deadline' ? 'timeout' : 'aborted',
        opts.signal.reason === 'deadline'
          ? { verdict: 'unavailable', reason: 'deadline' }
          : { verdict: 'cancelled', reason: 'stopped' },
      )
    if (this.o.signal) opts = { signal: AbortSignal.any([opts.signal, this.o.signal]) }
    if (opts.signal.aborted) return interrupted()
    const deadline = Date.parse(req.deadline)
    if (!Number.isFinite(deadline))
      return this.done(req.requestId, 'malformed', { verdict: 'unavailable', reason: 'invalid-answer' })
    if (deadline <= this.o.clock())
      return this.done(req.requestId, 'timeout', { verdict: 'unavailable', reason: 'deadline' })
    const automatic = req.delegation ? undefined : await automaticRequestDecision(req)
    if (automatic) {
      if (opts.signal.aborted) return interrupted()
      if (deadline <= this.o.clock())
        return this.done(req.requestId, 'timeout', { verdict: 'unavailable', reason: 'deadline' })
      await completeAutomaticDecision(req, this.o.clock)
      if (opts.signal.aborted) return interrupted()
      if (deadline <= this.o.clock())
        return this.done(req.requestId, 'timeout', { verdict: 'unavailable', reason: 'deadline' })
      return this.done(req.requestId, 'full-access', automatic)
    }
    if (this.o.local) {
      const snapshot = structuredClone(req)
      const raw = await this.o.local.ask(structuredClone(req), opts)
      if (opts.signal.aborted) return interrupted()
      if (typeof raw === 'object' && 'ticket' in raw) return raw
      const answer = typeof raw === 'string' ? { verdict: raw } : raw
      if (answer.verdict === 'unavailable' || answer.verdict === 'cancelled')
        return this.done(req.requestId, 'local', answer)
      if (
        !(snapshot.options ?? ['allowed-once', 'allowed-session', 'rejected']).includes(answer.verdict) ||
        (snapshot.approval && answer.verdict !== 'allowed-once' && answer.verdict !== 'rejected') ||
        !this.o.localActor
      )
        return this.done(req.requestId, 'malformed', { verdict: 'unavailable', reason: 'invalid-answer' })
      const answeredBy = await this.o.localActor(req.sessionKey)
      if (opts.signal.aborted) return interrupted()
      if (!validateAgainst(ActorSchema, answeredBy).ok)
        return this.done(req.requestId, 'malformed', { verdict: 'unavailable', reason: 'invalid-answer' })
      if (deadline <= this.o.clock())
        return this.done(req.requestId, 'timeout', { verdict: 'unavailable', reason: 'deadline' })
      return this.done(req.requestId, 'local', {
        verdict: answer.verdict,
        answeredBy,
        ...(answer.verdict === 'rejected' ? { reason: 'user-rejected' as const } : {}),
      })
    }
    const offered = (req.options ?? ['allowed-once', 'allowed-session', 'rejected']).filter(
      (v): v is 'allowed-once' | 'allowed-session' | 'rejected' => v !== 'allowed-permanent',
    )
    const optionKinds = offered.map(toAcpOptionKind)
    const optionIds = new Set<string>(optionKinds)
    if (!optionIds.size)
      return this.done(req.requestId, 'malformed', { verdict: 'unavailable', reason: 'invalid-answer' })
    const params = {
      sessionId: req.sessionKey,
      toolCall: {
        toolCallId: req.toolUseId ?? req.requestId,
        title: req.summary,
        ...(req.tool ? { rawInput: structuredClone(req.tool.args) } : {}),
        kind: req.kind === 'tool' ? toolKind(req.tool?.name) : 'other',
        status: 'pending',
        // The tool's name, so a client can say what "allow for the session" covers.
        _meta: {
          'ai.agnes.harness': {
            ...(req.tool ? { tool: req.tool.name } : {}),
            ...(req.delegation ? { delegation: req.delegation } : {}),
            category:
              isPermissionPurpose(req.kind === 'tool' ? 'permission' : req.kind) &&
              req.tool?.name !== 'exit_plan_mode'
                ? 'permission'
                : 'question',
            purpose: req.tool?.name === 'exit_plan_mode' ? 'plan.exit' : req.kind,
          },
        },
      },
      // This request is ACP. Its allow_always is session-scoped and must never be upgraded into
      // Agnes' distinct profile-scoped permanent verdict.
      options: optionKinds.map((k) => ({ optionId: k, name: k, kind: k })),
      _meta: { 'ai.agnes.harness': { deadline: req.deadline, requestId: req.requestId } },
    }
    const deadlineAt = Date.parse(req.deadline)
    // A refresh closes the socket that was holding the question. That connection is skipped so the
    // same approval is asked again, and is never recorded as a rejection of its own.
    const skipped = new Set<ConnectionState>()
    let asked = false
    const offers = new Set<LocalEndpoint>()
    try {
      while (true) {
        if (opts.signal.aborted) return interrupted()
        const remaining = deadlineAt - this.o.clock()
        const expired = Number.isFinite(deadlineAt) && remaining <= 0
        if (expired)
          return this.done(req.requestId, 'timeout', { verdict: 'unavailable', reason: 'deadline' })
        const live = this.o.connections()
        const candidate = this.o.originOf(req.sessionKey)
        const origin = candidate && live.includes(candidate) ? candidate : undefined
        const target = [origin, ...live.filter((c) => c !== origin && c.attached.has(req.sessionKey))].filter(
          (c): c is ConnectionState => !!c && c.capabilities.permission && !skipped.has(c),
        )[0]
        // 'unavailable' hands control to the preset's on_unavailable, so it is reserved for the one case
        // where nothing was asked. A dropped connection is not that case: nobody has answered yet.
        if (!target) {
          if (!asked && skipped.size === 0)
            return this.done(req.requestId, 'absent', { verdict: 'unavailable', reason: 'no-approver' })
          await this.waitForConnection(req.sessionKey, remaining, opts.signal)
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
          offers.add(endpoint)
          res = await endpoint.request('session/request_permission', params, {
            signal: opts.signal,
            ...(Number.isFinite(remaining) && remaining > 0 ? { timeoutMs: remaining } : {}),
          })
        } catch (e) {
          if (opts.signal.aborted) return interrupted()
          // The browser refreshed. Keep the original question open for the next attached client until
          // the deadline. A timeout, any other transport fault, and a client JSON-RPC error still fail
          // closed: 'unavailable' would let an outage pick up whatever on_unavailable allows.
          if (disconnected(e)) {
            skipped.add(target)
            continue
          }
          const cause = causeOf(e)
          return this.done(req.requestId, cause, {
            verdict: 'unavailable',
            reason: cause === 'timeout' ? 'deadline' : 'transport',
          })
        }
        const outcome = (res as { outcome?: { outcome?: unknown; optionId?: unknown } } | undefined)?.outcome
        // Transport detach is an offer loss; another connection can still answer the same request.
        if (opts.signal.aborted) return interrupted()
        if (Number.isFinite(deadlineAt) && this.o.clock() >= deadlineAt)
          return this.done(req.requestId, 'timeout', { verdict: 'unavailable', reason: 'deadline' })
        const metadata = (
          res as { _meta?: { 'ai.agnes.harness'?: { reason?: unknown; sourceCredential?: unknown } } }
        )?._meta?.['ai.agnes.harness']
        if (outcome?.outcome === 'cancelled') {
          const reason = metadata?.reason
          if (reason === undefined || reason === 'detached') {
            skipped.add(target)
            continue
          }
          const unanswered: ApprovalReason = [
            'deadline',
            'no-handler',
            'transport',
            'invalid-answer',
          ].includes(String(reason))
            ? (reason as ApprovalReason)
            : 'invalid-answer'
          return this.done(req.requestId, unanswered === 'deadline' ? 'timeout' : 'malformed', {
            verdict: 'unavailable',
            reason: unanswered,
          })
        }
        if (
          outcome?.outcome === 'selected' &&
          typeof outcome.optionId === 'string' &&
          optionIds.has(outcome.optionId)
        ) {
          const verdict = fromAcpOptionKind(outcome.optionId as AcpPermissionKind)
          let answeredBy: Actor
          try {
            answeredBy = await approvalActor(
              target,
              req.sessionKey,
              this.o.resolveActor,
              this.o.verifySource,
              metadata?.sourceCredential,
            )
          } catch {
            return this.done(req.requestId, 'malformed', { verdict: 'unavailable', reason: 'invalid-answer' })
          }
          if (opts.signal.aborted) return interrupted()
          if (Number.isFinite(deadlineAt) && this.o.clock() >= deadlineAt)
            return this.done(req.requestId, 'timeout', { verdict: 'unavailable', reason: 'deadline' })
          if (
            !this.o.connections().includes(target) ||
            !target.capabilities.permission ||
            (this.o.originOf(req.sessionKey) !== target && !target.attached.has(req.sessionKey))
          ) {
            skipped.add(target)
            continue
          }
          return this.done(req.requestId, 'answered', {
            verdict,
            answeredBy,
            ...(verdict === 'rejected' ? { reason: 'user-rejected' as const } : {}),
          })
        }
        return this.done(req.requestId, 'malformed', { verdict: 'unavailable', reason: 'invalid-answer' })
      }
    } finally {
      for (const endpoint of offers) {
        try {
          endpoint.push({
            jsonrpc: '2.0',
            method: '_agnes/v1/approval.withdraw',
            params: {
              sessionId: req.sessionKey,
              requestId: req.requestId,
              reason: opts.signal.aborted
                ? opts.signal.reason === 'deadline'
                  ? 'deadline'
                  : 'stopped'
                : 'detached',
            },
          })
        } catch {
          /* A closed transport already withdrew its offer. */
        }
      }
    }
  }
}
