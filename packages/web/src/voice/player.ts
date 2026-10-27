export type PlayOutcome = 'ended' | 'stopped' | 'blocked' | 'failed'
export type PlayerPhase = 'idle' | 'loading' | 'playing' | 'blocked'
export interface PlayerSnapshot {
  nodeId?: string
  phase: PlayerPhase
}

export interface SpeechPlayerDeps {
  /** Returns base64 mp3 for one segment; rejects on failure. Must honour `signal`. */
  synthesize(text: string, signal: AbortSignal): Promise<string>
  createAudio(url: string): HTMLAudioElement
  createUrl?(blob: Blob): string
  revokeUrl?(url: string): void
  /** Called once per `play()`, when its first sound starts. */
  onStart?(): void
}

class Stopped extends Error {}

interface Fetch {
  promise: Promise<string>
  done: boolean
}

interface Run {
  readonly nodeId: string
  readonly abort: AbortController
  readonly urls: Set<string>
  readonly first: Promise<PlayOutcome>
  readonly final: Promise<PlayOutcome>
  reportFirst(outcome: PlayOutcome): void
  settle(outcome: PlayOutcome): void
  started: boolean
  audio?: HTMLAudioElement
  interrupt?: ((reason: Error) => void) | undefined
  /** Plays the held element again; called from the click that resumes a blocked player. */
  retry?: (() => void) | undefined
}

const IDLE: PlayerSnapshot = { phase: 'idle' }
const noop = (): void => {}

function newRun(nodeId: string): Run {
  let reportFirst: (outcome: PlayOutcome) => void = noop
  let reportFinal: (outcome: PlayOutcome) => void = noop
  const first = new Promise<PlayOutcome>((resolve) => {
    reportFirst = resolve
  })
  const final = new Promise<PlayOutcome>((resolve) => {
    reportFinal = resolve
  })
  return {
    nodeId,
    abort: new AbortController(),
    urls: new Set(),
    first,
    final,
    reportFirst,
    settle: (outcome) => {
      reportFirst(outcome)
      reportFinal(outcome)
    },
    started: false,
  }
}

function decode(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
}

/**
 * Plays a reply as a playlist of synthesized segments: while one segment plays the next is synthesized (two
 * calls at most in flight). `stop()` aborts pending synthesis, pauses, revokes object URLs and drops late
 * results. An autoplay refusal leaves the element held in phase `blocked`: `play()` resolves `'blocked'` once
 * and `resume()`, called from a user gesture, continues the same playlist.
 */
export class SpeechPlayer {
  private run: Run | undefined
  private snapshot: PlayerSnapshot = IDLE
  private readonly listeners = new Set<() => void>()

  readonly state = {
    getSnapshot: (): PlayerSnapshot => this.snapshot,
    subscribe: (listener: () => void): (() => void) => {
      this.listeners.add(listener)
      return () => {
        this.listeners.delete(listener)
      }
    },
  }

  constructor(private readonly deps: SpeechPlayerDeps) {}

  play(nodeId: string, segments: readonly string[]): Promise<PlayOutcome> {
    this.stop()
    if (segments.length === 0) return Promise.resolve('ended')
    const run = newRun(nodeId)
    this.run = run
    this.set({ nodeId, phase: 'loading' })
    void this.drive(run, segments)
    return run.first
  }

  stop(): void {
    const run = this.run
    if (!run) return
    this.run = undefined
    run.abort.abort()
    run.audio?.pause()
    run.interrupt?.(new Stopped())
    this.revokeAll(run)
    this.set(IDLE)
    run.settle('stopped')
  }

  /** Continues a blocked playlist; resolves when it ends. Call it inside the user gesture. */
  resume(): Promise<void> {
    const run = this.run
    if (!run || this.snapshot.phase !== 'blocked') return Promise.resolve()
    run.retry?.()
    return run.final.then(noop)
  }

  private async drive(run: Run, segments: readonly string[]): Promise<void> {
    let outcome: PlayOutcome = 'ended'
    try {
      const start = (index: number): Fetch | undefined => {
        const text = segments[index]
        return text === undefined ? undefined : this.fetch(run, text)
      }
      let next = start(0)
      for (let i = 0; next; i++) {
        if (!next.done) this.set({ nodeId: run.nodeId, phase: 'loading' })
        const url = await next.promise
        next = start(i + 1)
        await this.playUrl(run, url)
        this.revoke(run, url)
      }
    } catch (error) {
      outcome = this.run === run && !(error instanceof Stopped) ? 'failed' : 'stopped'
      // A failed playlist must not leave its prefetch running.
      run.abort.abort()
    }
    if (this.run === run) {
      this.run = undefined
      this.revokeAll(run)
      this.set(IDLE)
    }
    run.settle(outcome)
  }

  private fetch(run: Run, text: string): Fetch {
    const entry: Fetch = { done: false, promise: Promise.resolve('') }
    entry.promise = (async () => {
      const base64 = await this.deps.synthesize(text, run.abort.signal)
      if (this.run !== run) throw new Stopped()
      const blob = new Blob([decode(base64)], { type: 'audio/mpeg' })
      const url = this.deps.createUrl ? this.deps.createUrl(blob) : URL.createObjectURL(blob)
      run.urls.add(url)
      entry.done = true
      return url
    })()
    entry.promise.catch(noop)
    return entry
  }

  private playUrl(run: Run, url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const audio = this.deps.createAudio(url)
      run.audio = audio
      const cleanup = () => {
        audio.removeEventListener('ended', onEnded)
        audio.removeEventListener('error', onError)
        run.interrupt = undefined
        run.retry = undefined
      }
      const onEnded = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new Error('audio element error'))
      }
      audio.addEventListener('ended', onEnded)
      audio.addEventListener('error', onError)
      run.interrupt = (reason) => {
        cleanup()
        reject(reason)
      }
      const start = () => {
        Promise.resolve(audio.play()).then(
          () => this.playing(run),
          (error: unknown) => {
            if ((error as { name?: string } | undefined)?.name === 'NotAllowedError') {
              this.blocked(run)
              return
            }
            cleanup()
            reject(error)
          },
        )
      }
      run.retry = start
      start()
    })
  }

  private playing(run: Run): void {
    if (this.run !== run) return
    this.set({ nodeId: run.nodeId, phase: 'playing' })
    if (run.started) return
    run.started = true
    this.deps.onStart?.()
  }

  private blocked(run: Run): void {
    if (this.run !== run) return
    this.set({ nodeId: run.nodeId, phase: 'blocked' })
    run.reportFirst('blocked')
  }

  private revoke(run: Run, url: string): void {
    if (run.urls.delete(url)) this.deps.revokeUrl ? this.deps.revokeUrl(url) : URL.revokeObjectURL(url)
  }

  private revokeAll(run: Run): void {
    for (const url of [...run.urls]) this.revoke(run, url)
  }

  private set(next: PlayerSnapshot): void {
    if (next.phase === this.snapshot.phase && next.nodeId === this.snapshot.nodeId) return
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}
