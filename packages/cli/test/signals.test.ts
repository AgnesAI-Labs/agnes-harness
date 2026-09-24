import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { installSignalLadder } from '../src/boot/signals.js'

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('signal ladder', () => {
  it('a first SIGINT cancels, then closes, then exits 130', async () => {
    const proc = new EventEmitter()
    const seen: string[] = []
    const exits: number[] = []
    installSignalLadder(
      {
        cancel: async () => {
          seen.push('cancel')
        },
        close: async () => {
          await tick(30)
          seen.push('close')
        },
      },
      { graceMs: 1000, exit: (c) => exits.push(c), proc },
    )
    proc.emit('SIGINT')
    await tick(5)
    expect(seen).toEqual(['cancel'])
    expect(exits).toEqual([])
    await tick(60)
    expect(seen).toEqual(['cancel', 'close'])
    expect(exits).toEqual([130])
  })

  it('a second signal exits at once, without waiting for the first shutdown', async () => {
    const proc = new EventEmitter()
    const seen: string[] = []
    const exits: number[] = []
    installSignalLadder(
      {
        cancel: async () => {
          seen.push('cancel')
        },
        close: async () => {
          await tick(50)
          seen.push('close')
        },
      },
      { graceMs: 1000, exit: (c) => exits.push(c), proc },
    )
    proc.emit('SIGINT')
    await tick(5)
    proc.emit('SIGTERM')
    expect(exits).toEqual([143])
    await tick(80)
    expect(seen).toEqual(['cancel', 'close'])
    expect(exits).toEqual([143, 130])
  })

  // A shutdown that overran the grace used to exit twice: once when the timer fired and again when
  // the close eventually finished. In production process.exit does not return, so it was invisible;
  // anywhere the exit is a function it is a second, contradictory report.
  it('a shutdown that overruns the grace exits once, not again when it finishes', async () => {
    const proc = new EventEmitter()
    const exits: number[] = []
    installSignalLadder(
      { cancel: async () => undefined, close: () => tick(60) },
      { graceMs: 20, exit: (c) => exits.push(c), proc },
    )
    proc.emit('SIGINT')
    await tick(15)
    expect(exits).toEqual([])
    await tick(20)
    expect(exits).toEqual([130])
    await tick(60)
    expect(exits).toEqual([130])
  })

  it('honours the grace budget when close never settles', async () => {
    const proc = new EventEmitter()
    const exits: number[] = []
    const said: string[] = []
    installSignalLadder(
      { cancel: async () => undefined, close: () => new Promise<void>(() => undefined) },
      { graceMs: 20, exit: (c) => exits.push(c), proc, log: (s) => said.push(s) },
    )
    proc.emit('SIGHUP')
    await tick(60)
    expect(exits).toEqual([129])
    expect(said).toEqual(['shutdown exceeded 20 ms'])
  })

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ])('%s exits %d', async (sig, code) => {
    const proc = new EventEmitter()
    const exits: number[] = []
    installSignalLadder(
      { cancel: async () => undefined, close: async () => undefined },
      { graceMs: 1000, exit: (c) => exits.push(c), proc },
    )
    proc.emit(sig)
    await tick(5)
    expect(exits).toEqual([code])
  })

  // A cancel that throws still owes the close, and a close that throws still owes the exit. Written
  // as a case because the alternative -- a rejection escaping the handler -- is an unhandled
  // rejection on the way out of a process that is already shutting down, where nobody sees it.
  it('a throwing cancel does not skip the close, and a throwing close does not skip the exit', async () => {
    const proc = new EventEmitter()
    const exits: number[] = []
    let closed = false
    installSignalLadder(
      {
        cancel: async () => {
          throw new Error('cancel failed')
        },
        close: async () => {
          closed = true
          throw new Error('close failed')
        },
      },
      { graceMs: 1000, exit: (c) => exits.push(c), proc },
    )
    proc.emit('SIGINT')
    await tick(10)
    expect(closed).toBe(true)
    expect(exits).toEqual([130])
  })

  it('the uninstaller takes every handler back off, so a later signal reaches nothing', async () => {
    const proc = new EventEmitter()
    const exits: number[] = []
    const off = installSignalLadder(
      { cancel: async () => undefined, close: async () => undefined },
      { graceMs: 1000, exit: (c) => exits.push(c), proc },
    )
    off()
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) proc.emit(sig)
    await tick(10)
    expect(exits).toEqual([])
    expect(proc.listenerCount('SIGINT')).toBe(0)
  })
})
