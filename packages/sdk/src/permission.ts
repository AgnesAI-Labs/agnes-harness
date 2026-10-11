import {
  type AcpPermissionKind,
  APPROVAL_REASONS,
  type ApprovalReason,
  toAcpOptionKind,
} from '@agnes/protocol'
export type PermissionOption = { optionId: string; name: string; kind: AcpPermissionKind }
export type PermissionRequest = {
  sessionId: string
  requestId?: string
  toolCall: Record<string, unknown>
  options: PermissionOption[]
  deadlineMs?: number
}
export type PermissionOutcome =
  | { optionId: string; sourceCredential?: unknown }
  | {
      verdict: 'allowed-once' | 'allowed-session' | 'allowed-permanent' | 'rejected'
      sourceCredential?: unknown
    }
  | { unanswered: ApprovalReason }
export type PermissionHandler = (
  request: PermissionRequest,
  context: { signal: AbortSignal },
) => Promise<PermissionOutcome>
type Answer = {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }
  _meta?: { 'ai.agnes.harness': { reason?: ApprovalReason; sourceCredential?: unknown } }
}
export const unansweredPermission = (reason: ApprovalReason): Answer => ({
  outcome: { outcome: 'cancelled' },
  _meta: { 'ai.agnes.harness': { reason } },
})
export class PermissionGate {
  private current: { handler: PermissionHandler; ac: AbortController } | undefined
  private readonly requests = new Map<string, AbortController>()
  private closed = false
  register(handler: PermissionHandler): () => void {
    this.current?.ac.abort('detached')
    if (this.closed) return () => {}
    const entry = { handler, ac: new AbortController() }
    this.current = entry
    return () => {
      entry.ac.abort('detached')
      if (this.current === entry) this.current = undefined
    }
  }
  close(): void {
    this.closed = true
    this.current?.ac.abort('detached')
    this.current = undefined
  }
  withdraw(requestId: string, reason: ApprovalReason): void {
    this.requests.get(requestId)?.abort(reason)
  }
  async answer(request: PermissionRequest): Promise<Answer> {
    const original = structuredClone(request)
    const entry = this.current
    if (this.closed) return unansweredPermission('detached')
    if (!entry) return unansweredPermission('no-handler')
    if (new Set(original.options.map((o) => o.optionId)).size !== original.options.length)
      return unansweredPermission('invalid-answer')
    const ac = new AbortController()
    if (original.requestId) {
      if (this.requests.has(original.requestId)) return unansweredPermission('invalid-answer')
      this.requests.set(original.requestId, ac)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const detach = () => ac.abort('detached')
    entry.ac.signal.addEventListener('abort', detach, { once: true })
    const interrupted = new Promise<PermissionOutcome>((resolve) => {
      ac.signal.addEventListener(
        'abort',
        () =>
          resolve({
            unanswered: APPROVAL_REASONS.includes(ac.signal.reason) ? ac.signal.reason : 'detached',
          }),
        { once: true },
      )
    })
    if (original.deadlineMs !== undefined) {
      const arm = () => {
        const left = original.deadlineMs! - Date.now()
        if (!Number.isFinite(left) || left <= 0) ac.abort('deadline')
        else timer = setTimeout(arm, Math.min(left, 2147483647))
      }
      arm()
    }
    try {
      const out = await Promise.race([
        Promise.resolve().then(() =>
          ac.signal.aborted
            ? { unanswered: ac.signal.reason }
            : entry.handler(structuredClone(original), { signal: ac.signal }),
        ),
        interrupted,
      ])
      if (original.deadlineMs !== undefined && original.deadlineMs <= Date.now())
        return unansweredPermission('deadline')
      if (ac.signal.aborted) return unansweredPermission(ac.signal.reason)
      if (!out || typeof out !== 'object') return unansweredPermission('invalid-answer')
      if ('unanswered' in out)
        return unansweredPermission(
          APPROVAL_REASONS.includes(out.unanswered) && out.unanswered !== 'user-rejected'
            ? out.unanswered
            : 'invalid-answer',
        )
      let option: PermissionOption | undefined
      if ('optionId' in out) option = original.options.find((o) => o.optionId === out.optionId)
      else if (
        out.verdict === 'allowed-once' ||
        out.verdict === 'allowed-session' ||
        out.verdict === 'rejected'
      ) {
        const kind = toAcpOptionKind(out.verdict)
        option = original.options.find((o) => o.kind === kind)
      }
      if (!option) return unansweredPermission('invalid-answer')
      return {
        outcome: { outcome: 'selected', optionId: option.optionId },
        ...(out.sourceCredential === undefined
          ? {}
          : {
              _meta: { 'ai.agnes.harness': { sourceCredential: out.sourceCredential } },
            }),
      }
    } catch {
      return unansweredPermission('transport')
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      entry.ac.signal.removeEventListener('abort', detach)
      if (original.requestId && this.requests.get(original.requestId) === ac)
        this.requests.delete(original.requestId)
      ac.abort('detached')
    }
  }
}
