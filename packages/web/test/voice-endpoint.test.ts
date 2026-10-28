import { describe, expect, it } from 'vitest'
import { createEndpointDetector, type EndpointEvent } from '../src/voice/endpoint.js'

function feed(
  d: ReturnType<typeof createEndpointDetector>,
  rms: number,
  n: number,
): (EndpointEvent | undefined)[] {
  return Array.from({ length: n }, () => d.push(rms))
}

describe('createEndpointDetector', () => {
  it('calibrates 300 ms of floor, starts after 200 ms above three times the floor, ends after the pause', () => {
    const d = createEndpointDetector({ pauseMs: 1200, maxMs: 120_000 })
    for (let i = 0; i < 6; i++) expect(d.push(0.002)).toBeUndefined()
    for (let i = 0; i < 3; i++) expect(d.push(0.05)).toBeUndefined()
    expect(d.push(0.05)).toBe('speech-start')
    for (let i = 0; i < 23; i++) expect(d.push(0.001)).toBeUndefined()
    expect(d.push(0.001)).toBe('speech-end')
  })

  it('scales the threshold with a noisy floor', () => {
    const d = createEndpointDetector({ pauseMs: 1200, maxMs: 120_000 })
    feed(d, 0.02, 6)
    expect(feed(d, 0.05, 10).every((e) => e === undefined)).toBe(true)
    expect(feed(d, 0.07, 4)).toEqual([undefined, undefined, undefined, 'speech-start'])
  })

  it('uses the minimum threshold in a silent room', () => {
    const d = createEndpointDetector({ pauseMs: 1200, maxMs: 120_000 })
    feed(d, 0, 6)
    expect(feed(d, 0.009, 20).every((e) => e === undefined)).toBe(true)
    expect(feed(d, 0.011, 4)).toEqual([undefined, undefined, undefined, 'speech-start'])
  })

  it('needs the onset frames to be consecutive', () => {
    const d = createEndpointDetector({ pauseMs: 1200, maxMs: 120_000 })
    feed(d, 0, 6)
    feed(d, 0.05, 3)
    d.push(0.001)
    expect(feed(d, 0.05, 3).every((e) => e === undefined)).toBe(true)
    expect(d.push(0.05)).toBe('speech-start')
  })

  it('does not end on a short dip inside the utterance', () => {
    const d = createEndpointDetector({ pauseMs: 1200, maxMs: 120_000 })
    feed(d, 0, 6)
    feed(d, 0.05, 4)
    expect(feed(d, 0.001, 23).every((e) => e === undefined)).toBe(true)
    expect(d.push(0.05)).toBeUndefined()
    expect(feed(d, 0.001, 23).every((e) => e === undefined)).toBe(true)
    expect(d.push(0.001)).toBe('speech-end')
  })

  it('times out after 30 s without speech', () => {
    const d = createEndpointDetector({ pauseMs: 1200, maxMs: 120_000 })
    for (let i = 0; i < 599; i++) expect(d.push(0.002)).toBeUndefined()
    expect(d.push(0.002)).toBe('idle-timeout')
  })

  it('stops an utterance at the maximum length counted from speech start', () => {
    const d = createEndpointDetector({ pauseMs: 1200, maxMs: 2000 })
    const events: (EndpointEvent | undefined)[] = []
    for (let frame = 1; frame <= 60; frame++) events.push(d.push(frame <= 6 ? 0 : 0.05))
    expect(events.indexOf('speech-start') + 1).toBe(10)
    expect(events.indexOf('max-length') + 1).toBe(50)
    expect(events.slice(10, 49).every((e) => e === undefined)).toBe(true)
  })

  it('goes quiet after an event until it is reset', () => {
    const d = createEndpointDetector({ pauseMs: 100, maxMs: 120_000 })
    feed(d, 0, 6)
    feed(d, 0.05, 4)
    expect(feed(d, 0.001, 2)).toEqual([undefined, 'speech-end'])
    expect(feed(d, 0.05, 10).every((e) => e === undefined)).toBe(true)
    d.reset()
    feed(d, 0, 6)
    expect(feed(d, 0.05, 4).at(-1)).toBe('speech-start')
  })

  it('honours custom frame, floor and onset settings', () => {
    const d = createEndpointDetector({
      pauseMs: 400,
      maxMs: 10_000,
      frameMs: 100,
      floorMs: 200,
      onsetMs: 300,
    })
    feed(d, 0, 2)
    expect(feed(d, 0.05, 3)).toEqual([undefined, undefined, 'speech-start'])
    expect(feed(d, 0.001, 4)).toEqual([undefined, undefined, undefined, 'speech-end'])
  })
})
