export type EndpointEvent = 'speech-start' | 'speech-end' | 'idle-timeout' | 'max-length'

export interface EndpointOptions {
  pauseMs: number
  maxMs: number
  frameMs?: number
  floorMs?: number
  factor?: number
  minThreshold?: number
  onsetMs?: number
  idleMs?: number
}

/**
 * Frame-by-frame end-of-speech detector. The first `floorMs` of frames set the noise floor; speech starts
 * after `onsetMs` of frames above `max(minThreshold, floor * factor)` and ends after `pauseMs` below it.
 * `maxMs` limits one utterance, counted from the speech-start frame. After an event it stays silent until
 * `reset()`.
 */
export function createEndpointDetector(o: EndpointOptions): {
  push(rms: number): EndpointEvent | undefined
  reset(): void
} {
  const frameMs = o.frameMs ?? 50
  const floorFrames = Math.round((o.floorMs ?? 300) / frameMs)
  const onsetFrames = Math.round((o.onsetMs ?? 200) / frameMs)
  const pauseFrames = Math.round(o.pauseMs / frameMs)
  const maxFrames = Math.round(o.maxMs / frameMs)
  const idleFrames = Math.round((o.idleMs ?? 30_000) / frameMs)
  const factor = o.factor ?? 3
  const minThreshold = o.minThreshold ?? 0.01
  let state: {
    frames: number
    floorSum: number
    threshold: number
    run: number
    speechFrames: number
    phase: 'idle' | 'speech' | 'done'
  }
  const reset = (): void => {
    state = { frames: 0, floorSum: 0, threshold: minThreshold, run: 0, speechFrames: 0, phase: 'idle' }
  }
  reset()

  const finish = (event: EndpointEvent): EndpointEvent => {
    state.phase = 'done'
    return event
  }

  const push = (rms: number): EndpointEvent | undefined => {
    if (state.phase === 'done') return undefined
    state.frames++
    if (state.frames <= floorFrames) {
      state.floorSum += rms
      if (state.frames === floorFrames) {
        state.threshold = Math.max(minThreshold, (state.floorSum / floorFrames) * factor)
      }
      return state.frames >= idleFrames ? finish('idle-timeout') : undefined
    }
    const loud = rms > state.threshold
    if (state.phase === 'idle') {
      state.run = loud ? state.run + 1 : 0
      if (state.run >= onsetFrames) {
        state.phase = 'speech'
        state.run = 0
        state.speechFrames = 0
        return 'speech-start'
      }
      return state.frames >= idleFrames ? finish('idle-timeout') : undefined
    }
    state.speechFrames++
    state.run = loud ? 0 : state.run + 1
    if (state.run >= pauseFrames) return finish('speech-end')
    return state.speechFrames >= maxFrames ? finish('max-length') : undefined
  }

  return { push, reset }
}
