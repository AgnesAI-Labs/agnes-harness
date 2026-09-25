/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bootstrapProbe,
  createReconnectController,
  probeBootstrap,
  type ReconnectPhase,
} from '../src/reconnect.js'

/** Lets pending probe promises settle between timer steps. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

function harness(answers: () => boolean) {
  const probe = vi.fn(async (_signal: AbortSignal, _manual: boolean) => answers())
  const reload = vi.fn()
  const phases: ReconnectPhase[] = []
  const controller = createReconnectController({ probe, reload, onPhase: (phase) => phases.push(phase) })
  return { probe, reload, phases, controller }
}

describe('reconnect controller', () => {
  afterEach(() => vi.useRealTimers())

  it('never reloads while the server is unreachable and keeps probing with capped backoff', async () => {
    vi.useFakeTimers()
    const { probe, reload, phases, controller } = harness(() => false)
    controller.start()
    expect(phases).toEqual(['waiting'])
    await advance(499)
    expect(probe).not.toHaveBeenCalled()
    await advance(1)
    expect(probe).toHaveBeenCalledTimes(1)
    await advance(1000)
    expect(probe).toHaveBeenCalledTimes(2)
    await advance(2000)
    expect(probe).toHaveBeenCalledTimes(3)
    // Capped: every later attempt waits the same few seconds, never longer.
    await advance(3000)
    expect(probe).toHaveBeenCalledTimes(4)
    await advance(3000)
    expect(probe).toHaveBeenCalledTimes(5)
    await advance(30_000)
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(15)
    expect(reload).not.toHaveBeenCalled()
    expect(controller.phase()).toBe('waiting')
  })

  it('reloads exactly once, and only after the probe answers', async () => {
    vi.useFakeTimers()
    let up = false
    const { probe, reload, phases, controller } = harness(() => up)
    controller.start()
    await advance(3500)
    expect(probe).toHaveBeenCalledTimes(3)
    expect(reload).not.toHaveBeenCalled()
    up = true
    await advance(3000)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(phases.at(-1)).toBe('recovering')
    const probes = probe.mock.calls.length
    controller.start()
    controller.retry()
    await advance(60_000)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledTimes(probes)
  })

  it('shows a stalled state after the retry window and recovers through the manual retry', async () => {
    vi.useFakeTimers()
    let up = false
    const { probe, reload, phases, controller } = harness(() => up)
    controller.start()
    await advance(60_000)
    expect(reload).not.toHaveBeenCalled()
    await advance(5_000)
    expect(controller.phase()).toBe('stalled')
    expect(phases.at(-1)).toBe('stalled')
    const probes = probe.mock.calls.length
    await advance(120_000)
    expect(probe).toHaveBeenCalledTimes(probes)
    // A manual retry while still down probes at once and starts a fresh window.
    controller.retry()
    expect(controller.phase()).toBe('waiting')
    await advance(0)
    expect(probe).toHaveBeenCalledTimes(probes + 1)
    expect(reload).not.toHaveBeenCalled()
    up = true
    await advance(1000)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('treats a probe that never answers as a failure', async () => {
    vi.useFakeTimers()
    const probe = vi.fn(
      (signal: AbortSignal) =>
        new Promise<boolean>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        ),
    )
    const reload = vi.fn()
    const controller = createReconnectController({ probe, reload })
    controller.start()
    await advance(500)
    expect(probe).toHaveBeenCalledTimes(1)
    await advance(3000 + 1000)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(reload).not.toHaveBeenCalled()
  })

  it('does not probe or reload after cancellation, and reset returns it to idle', async () => {
    vi.useFakeTimers()
    const { probe, reload, controller } = harness(() => true)
    controller.start()
    controller.cancel()
    await advance(60_000)
    expect(probe).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    controller.reset()
    expect(controller.phase()).toBe('idle')
    controller.start()
    await advance(500)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('ignores a manual retry while a probe is still in flight', async () => {
    vi.useFakeTimers()
    let answer: ((up: boolean) => void) | undefined
    const probe = vi.fn(
      (_signal: AbortSignal, _manual: boolean) =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        }),
    )
    const reload = vi.fn()
    const controller = createReconnectController({ probe, reload })
    controller.start()
    await advance(500)
    expect(probe).toHaveBeenCalledTimes(1)
    controller.retry()
    controller.retry()
    await advance(0)
    expect(probe).toHaveBeenCalledTimes(1)
    answer?.(false)
    await advance(1000)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(reload).not.toHaveBeenCalled()
  })

  it('marks only the user-requested attempt as manual, and resumes a stalled window automatically', async () => {
    vi.useFakeTimers()
    const { probe, reload, controller } = harness(() => false)
    controller.resume()
    expect(controller.phase()).toBe('idle')
    controller.start()
    await advance(65_000)
    expect(controller.phase()).toBe('stalled')
    expect(probe.mock.calls.every(([, manual]) => manual === false)).toBe(true)
    let probes = probe.mock.calls.length
    controller.resume()
    await advance(0)
    expect(probe).toHaveBeenCalledTimes(probes + 1)
    expect(probe.mock.calls.at(-1)?.[1]).toBe(false)
    // While waiting again, resume is a no-op rather than a second loop.
    controller.resume()
    await advance(0)
    expect(probe).toHaveBeenCalledTimes(probes + 1)
    await advance(65_000)
    probes = probe.mock.calls.length
    controller.retry()
    await advance(0)
    expect(probe).toHaveBeenCalledTimes(probes + 1)
    expect(probe.mock.calls.at(-1)?.[1]).toBe(true)
    // The manual attempt failed; the follow-ups in its window are ordinary probes again.
    await advance(1000)
    expect(probe).toHaveBeenCalledTimes(probes + 2)
    expect(probe.mock.calls.at(-1)?.[1]).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('keeps retrying when the probe throws synchronously', async () => {
    vi.useFakeTimers()
    const probe = vi.fn((_signal: AbortSignal, _manual: boolean): Promise<boolean> => {
      throw new Error('probe broke')
    })
    const reload = vi.fn()
    const controller = createReconnectController({ probe, reload })
    controller.start()
    await advance(500)
    await advance(1000)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(controller.phase()).toBe('waiting')
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('bootstrap probe', () => {
  const page = (ws: string) => `<!doctype html><meta id="agnes-config" data-ws="${ws}" />`
  const serve =
    (body: string, status = 200) =>
    async (_input: string, _init?: RequestInit) =>
      new Response(body, { status })
  const signal = new AbortController().signal

  it('reads the daemon address the Web page serves', async () => {
    const ok = vi.fn(serve(page('ws://127.0.0.1:1/')))
    expect(await probeBootstrap(ok, signal)).toBe('ws://127.0.0.1:1/')
    expect(ok).toHaveBeenCalledWith('/', expect.objectContaining({ cache: 'no-store', signal }))
    expect(await probeBootstrap(serve('', 503), signal)).toBeUndefined()
    expect(await probeBootstrap(serve('<html></html>'), signal)).toBeUndefined()
    expect(
      await probeBootstrap(async () => {
        throw new TypeError('Failed to fetch')
      }, signal),
    ).toBeUndefined()
  })

  it('wants a reload only for a different daemon address, unless the user asked', async () => {
    const current = 'ws://127.0.0.1:1/'
    expect(await bootstrapProbe(serve(page(current)), current)(signal, false)).toBe(false)
    expect(await bootstrapProbe(serve(page(current)), current)(signal, true)).toBe(true)
    expect(await bootstrapProbe(serve(page('ws://127.0.0.1:2/')), current)(signal, false)).toBe(true)
    expect(await bootstrapProbe(serve('', 502), current)(signal, true)).toBe(false)
  })
})
