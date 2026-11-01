import { CoreError, type EventInput, type Seq } from '@agnes/core-common/types'
import { armTimeout, settlesWithin } from '@agnes/core-effects/effects/wrap'
import { publicErrorHelp } from '@agnes/protocol'
import { sessionIdentity } from '../../loop/scope.js'
import type { SessionImpl } from '../../step/session.js'
import { REVIEW_STOP, type ReviewReason, type ReviewState, readReviewState } from './review-state.js'

export const REVIEW_CODES = {
  requests: 'COMPLETION_REVIEW_REQUEST_LIMIT',
  deadline: 'COMPLETION_REVIEW_TIME_LIMIT',
  unavailable: 'COMPLETION_REVIEW_UNAVAILABLE',
} as const

/** Local control, never a user cancellation or a provider transport error. */
export class CompletionReviewStop extends Error {
  readonly code: string
  constructor(readonly reason: ReviewReason) {
    const code = REVIEW_CODES[reason]
    super(publicErrorHelp({ code })?.reason ?? 'Additional completion review is incomplete.')
    this.name = 'CompletionReviewStop'
    this.code = code
  }
}
type Control = {
  state: ReviewState
  controller: AbortController
  dispose: () => void
  stop?: CompletionReviewStop
  work: Set<Promise<unknown>>
}
const controls = new WeakMap<object, Control>()
const legacyDiagnostics = new WeakMap<object, Set<number>>()
const dispatches = new WeakMap<object, Set<string>>()
export function markReviewDispatch(s: SessionImpl, effectId: string, attempt: number): void {
  if (!reviewing(s)) return
  let entered = dispatches.get(sessionIdentity(s))
  if (!entered) {
    entered = new Set()
    dispatches.set(sessionIdentity(s), entered)
  }
  entered.add(`${effectId}:${attempt}`)
}
export const reviewDispatchStarted = (s: SessionImpl, effectId: string, attempt: number) =>
  dispatches.get(sessionIdentity(s))?.has(`${effectId}:${attempt}`) === true

export const isReviewCode = (code: string) => Object.values<string>(REVIEW_CODES).includes(code)
export const reviewState = (s: SessionImpl): ReviewState =>
  controls.get(sessionIdentity(s))?.state ?? { kind: 'none' }
export const reviewing = (s: SessionImpl) => ['active', 'invalid'].includes(reviewState(s).kind)
export const reviewSignal = (s: SessionImpl): AbortSignal => {
  const c = controls.get(sessionIdentity(s))
  return c ? AbortSignal.any([s.ac.signal, c.controller.signal]) : s.ac.signal
}
export function disposeReview(s: SessionImpl): void {
  controls.get(sessionIdentity(s))?.dispose()
  controls.delete(sessionIdentity(s))
  dispatches.delete(sessionIdentity(s))
}
export function stopReview(s: SessionImpl, reason: ReviewReason): CompletionReviewStop {
  const c = controls.get(sessionIdentity(s))
  if (c?.stop) return c.stop
  const stop = new CompletionReviewStop(reason)
  if (c) {
    c.stop = stop
    c.controller.abort(stop)
    c.dispose()
  }
  return stop
}
export function reviewStop(s: SessionImpl): CompletionReviewStop | undefined {
  const c = controls.get(sessionIdentity(s))
  if (c?.state.kind === 'active' && s.d.clock() >= c.state.budget.deadlineAt) return stopReview(s, 'deadline')
  return c?.stop
}

/** Always reload durable admissions; changing a preset cannot erase an admitted review. */
export async function refreshReview(s: SessionImpl): Promise<ReviewState> {
  const state = await readReviewState(s)
  const previous = controls.get(sessionIdentity(s))
  const same =
    previous &&
    'anchor' in state &&
    'anchor' in previous.state &&
    state.anchor?.ranSeq === previous.state.anchor?.ranSeq
  if (same) {
    previous.state = state
    if (state.kind === 'invalid') stopReview(s, 'unavailable')
    if (state.kind === 'active' && state.stopped) stopReview(s, state.stopped)
    return state
  }
  disposeReview(s)
  if (state.kind === 'legacy') {
    const identity = sessionIdentity(s)
    let seen = legacyDiagnostics.get(identity)
    if (!seen) {
      seen = new Set()
      legacyDiagnostics.set(identity, seen)
    }
    if (!seen.has(state.anchor.ranSeq)) {
      seen.add(state.anchor.ranSeq)
      await s.diag('invariant', { kind: 'completion-review-legacy', ranSeq: state.anchor.ranSeq })
    }
  }
  if (state.kind === 'none' || state.kind === 'legacy') return state
  const control: Control = {
    state,
    controller: new AbortController(),
    dispose: () => undefined,
    work: new Set(),
  }
  controls.set(sessionIdentity(s), control)
  if (state.kind === 'invalid') stopReview(s, 'unavailable')
  else if (state.stopped) stopReview(s, state.stopped)
  else {
    const left = state.budget.deadlineAt - s.d.clock()
    if (left <= 0) stopReview(s, 'deadline')
    else control.dispose = armTimeout(() => stopReview(s, 'deadline'), left, s.d.timers)
  }
  return state
}

export async function assertReview(
  s: SessionImpl,
  action: 'continue' | 'inference' | 'model-dispatch' | 'tool' | 'unsupported' = 'continue',
): Promise<void> {
  const state = await refreshReview(s)
  if (s.ac.signal.aborted || s.op()?.control.status === 'cancel_requested') s.ac.signal.throwIfAborted()
  const stop = reviewStop(s)
  if (stop) throw stop
  if (state.kind !== 'active') return
  if ((action === 'inference' || action === 'tool') && state.used >= state.budget.maxInferenceAdmissions)
    throw stopReview(s, 'requests')
  if (
    (action === 'tool' && state.budget.deadlineAt - s.d.clock() < 1_000) ||
    ((action === 'inference' || action === 'model-dispatch') && state.budget.deadlineAt - s.d.clock() < 100)
  )
    throw stopReview(s, 'deadline')
  if (action === 'unsupported') throw stopReview(s, 'unavailable')
}

/** Count and commit run under the same Session transition lock and storage commit. */
export async function admitReviewInference(
  s: SessionImpl,
  events: EventInput[],
  next: Parameters<SessionImpl['transition']>[1],
): Promise<Seq[]> {
  const expected = s.opSeq()
  const [seqs] = await s.transitionChain(
    [
      {
        events,
        next: (cur, seq) => {
          if (typeof next === 'function') return next(cur, seq)
          if (s.opSeq() !== expected) throw new CoreError('E_CAS', 'Inference phase changed before admission')
          return next
        },
      },
    ],
    {
      beforeCommit: () => assertReview(s, 'inference'),
      commitCheck: () => {
        const stop = reviewStop(s)
        if (stop) throw stop
      },
    },
  )
  return seqs!
}

export function reviewTimeout(s: SessionImpl, timeoutMs: number): number {
  const state = reviewState(s)
  return state.kind === 'active'
    ? Math.min(timeoutMs, Math.max(0, state.budget.deadlineAt - s.d.clock()))
    : timeoutMs
}

/** Bound preparation/hooks without interpreting their fail-open result as a completed review. */
export async function awaitReview<T>(s: SessionImpl, work: () => Promise<T>): Promise<T> {
  const signal = reviewSignal(s)
  if (!reviewing(s)) return work()
  signal.throwIfAborted()
  let cancel: () => void = () => undefined
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => reject(s.ac.signal.aborted ? s.ac.signal.reason : (reviewStop(s) ?? signal.reason))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
  try {
    const value = await Promise.race([work(), stopped])
    const stop = reviewStop(s)
    if (stop && !s.ac.signal.aborted) throw stop
    return value
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

export function reviewStopEvents(s: SessionImpl): EventInput[] {
  const state = reviewState(s)
  const stop = reviewStop(s)
  return stop && 'anchor' in state && state.anchor
    ? [s.ev(REVIEW_STOP, { ranSeq: state.anchor.ranSeq, reason: stop.reason }, { ignorable: true })]
    : []
}

/** Hook implementations keep their own cancellation identity; Core bounds the wait it owns. */
export function reviewHooks(
  s: SessionImpl,
  hooks: import('../../step/session.js').HookPort,
): import('../../step/session.js').HookPort {
  if (!reviewing(s)) return hooks
  const synchronous = new Set(['resources', 'resetTurn', 'shutdown', 'shutdownExtension'])
  return new Proxy(hooks, {
    get(target, key) {
      const value = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      if (synchronous.has(String(key))) return value.bind(target)
      return (...args: unknown[]) => awaitReview(s, async () => Reflect.apply(value, target, args))
    },
  })
}

/** Dynamic remaining allowance belongs in request notes, outside the stable system prefix. */
export function reviewRequestNote(s: SessionImpl) {
  const state = reviewState(s)
  return state.kind === 'active'
    ? {
        prefix: '[Completion review budget]',
        text: `Additional completion review: ${state.budget.maxInferenceAdmissions - state.used} Core inference admissions remain including this request; ${Math.max(0, state.budget.deadlineAt - s.d.clock())} ms remain. Reserve the last admission for the final answer: no new tool may start after it.`,
      }
    : undefined
}

/** Track Core-owned operations so the local stop can drain them without revoking session authority. */
export async function reviewWork<T>(s: SessionImpl, work: () => Promise<T>): Promise<T> {
  const control = controls.get(sessionIdentity(s))
  if (!control) return work()
  const pending = work()
  control.work.add(pending)
  try {
    return await pending
  } finally {
    control.work.delete(pending)
  }
}

export async function drainReviewWork(s: SessionImpl): Promise<void> {
  const pending = controls.get(sessionIdentity(s))?.work
  if (pending?.size) await settlesWithin(Promise.allSettled([...pending]), s.d.closeDrainMs ?? 1500)
}
