/**
 * Async video job polling: a video generation request is submitted once and then polled until it
 * reaches a terminal state, rather than streamed like text or images. This module is deliberately
 * provider-agnostic — `VideoClient` is the shape any vendor's video API must be adapted to, and
 * `pollUntilDone` is the backoff loop that drives it, so a real vendor client is a thin translation
 * layer and the timing/abort/timeout policy lives in exactly one place.
 */

export type VideoStatus = 'submitted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired'

export interface VideoClient {
  submit(req: { prompt: string; idempotencyKey: string }, signal: AbortSignal): Promise<{ jobId: string }>
  poll(jobId: string, signal: AbortSignal): Promise<{ status: VideoStatus; url?: string }>
  cancel(jobId: string, signal: AbortSignal): Promise<void>
}

export type PollUntilDoneOptions = {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  clock: () => number
  timeoutMs: number
  signal: AbortSignal
  onTick?: (status: VideoStatus) => void
}

/**
 * Polls a video job to a terminal state with exponential backoff: 2s, 4s, 8s, ... capped at 60s
 * between attempts, until either the job settles, the total elapsed time exceeds `timeoutMs` (the
 * job is left running server-side and reported `expired` rather than `failed`, since we don't know
 * its true fate), or `signal` aborts (in which case the job is actively cancelled and reported
 * `cancelled`, distinct from a timeout because here the caller asked to stop).
 */
export async function pollUntilDone(
  client: VideoClient,
  jobId: string,
  opts: PollUntilDoneOptions,
): Promise<{ status: VideoStatus; url?: string }> {
  const started = opts.clock()
  let delay = 2000
  for (;;) {
    if (opts.signal.aborted) {
      // The abort signal is already fired, so cancellation itself must not be tied to it — a fresh
      // controller is used so `cancel` actually gets to run instead of being aborted before it starts.
      await client.cancel(jobId, new AbortController().signal)
      return { status: 'cancelled' }
    }
    const r = await client.poll(jobId, opts.signal)
    opts.onTick?.(r.status)
    if (
      r.status === 'succeeded' ||
      r.status === 'failed' ||
      r.status === 'cancelled' ||
      r.status === 'expired'
    )
      return r
    if (opts.clock() - started >= opts.timeoutMs) return { status: 'expired' }
    await opts.sleep(delay, opts.signal)
    delay = Math.min(delay * 2, 60_000)
  }
}
