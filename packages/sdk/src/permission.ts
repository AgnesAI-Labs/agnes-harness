import { type AcpPermissionKind, toAcpOptionKind } from '@agnes/protocol'
export type PermissionOption = { optionId: string; name: string; kind: AcpPermissionKind }
export type PermissionRequest = {
  sessionId: string
  toolCall: Record<string, unknown>
  options: PermissionOption[]
  deadlineMs?: number
}
export type PermissionOutcome =
  | { optionId: string }
  | { verdict: 'allowed-once' | 'allowed-session' | 'allowed-permanent' | 'rejected' }
export type PermissionHandler = (
  request: PermissionRequest,
  context: { signal: AbortSignal },
) => Promise<PermissionOutcome>
type Answer = { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }
const cancelled = (): Answer => ({ outcome: { outcome: 'cancelled' } })
export function rejectPermission(request: PermissionRequest): Answer {
  if (new Set(request.options.map((o) => o.optionId)).size !== request.options.length)
    return { outcome: { outcome: 'cancelled' } }
  const reject = request.options.find((option) => option.kind === 'reject_once')
  return reject
    ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
    : { outcome: { outcome: 'cancelled' } }
}
export class PermissionGate {
  private current: { handler: PermissionHandler; ac: AbortController } | undefined
  private closed = false
  register(handler: PermissionHandler): () => void {
    this.current?.ac.abort()
    if (this.closed) return () => {}
    const entry = { handler, ac: new AbortController() }
    this.current = entry
    return () => {
      entry.ac.abort()
      if (this.current === entry) this.current = undefined
    }
  }
  close(): void {
    this.closed = true
    this.current?.ac.abort()
    this.current = undefined
  }
  async answer(request: PermissionRequest): Promise<Answer> {
    const original = structuredClone(request)
    const fallback = rejectPermission(original)
    const entry = this.current
    if (this.closed || !entry) return fallback
    // Ambiguous IDs cannot safely express a selected option.
    if (new Set(original.options.map((o) => o.optionId)).size !== original.options.length) return cancelled()
    const requestAbort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort!: () => void
    const interrupted = Symbol('permission-interrupted')
    const stopped = new Promise<typeof interrupted>((resolve) => {
      abort = () => {
        requestAbort.abort()
        resolve(interrupted)
      }
      entry.ac.signal.addEventListener('abort', abort, { once: true })
      if (original.deadlineMs !== undefined) {
        const deadline = original.deadlineMs
        const arm = () => {
          const left = deadline - Date.now()
          if (!Number.isFinite(left) || left <= 0) abort()
          else timer = setTimeout(arm, Math.min(left, 2147483647))
        }
        arm()
      }
    })
    try {
      if (original.deadlineMs !== undefined && original.deadlineMs <= Date.now()) return cancelled()
      const out = await Promise.race([
        Promise.resolve().then(() =>
          entry.ac.signal.aborted
            ? null
            : entry.handler(structuredClone(original), { signal: requestAbort.signal }),
        ),
        stopped,
      ])
      if (
        this.closed ||
        entry.ac.signal.aborted ||
        out === interrupted ||
        (original.deadlineMs !== undefined && original.deadlineMs <= Date.now())
      )
        return cancelled()
      if (!out || typeof out !== 'object') return fallback
      let option: PermissionOption | undefined
      if ('optionId' in out) option = original.options.find((o) => o.optionId === out.optionId)
      // ACP has no permanent option. Accept the Agnes verdict at the SDK type boundary, but never
      // upgrade ACP's `allow_always` (session) or invent an unoffered option to carry it.
      else if (
        out.verdict === 'allowed-once' ||
        out.verdict === 'allowed-session' ||
        out.verdict === 'rejected'
      ) {
        const kind = toAcpOptionKind(out.verdict)
        option = original.options.find((o) => o.kind === kind)
      }
      return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : fallback
    } catch {
      return fallback
    } finally {
      requestAbort.abort()
      if (timer !== undefined) clearTimeout(timer)
      entry.ac.signal.removeEventListener('abort', abort)
    }
  }
}
