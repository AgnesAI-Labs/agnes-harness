import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBrowserLog, installBrowserLogCapture, resetBrowserLogForTest } from '../src/browser-log.js'

// Fake secret built by concatenation, never a literal secret-shaped string in source.
const FAKE_BEARER_TOKEN = 't'.repeat(30)

type FakeConsole = Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'>

function makeFakeConsole(): FakeConsole {
  return { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function makeFakeWindowWithDispatch(): { window: Window; fire: (type: string, event: unknown) => void } {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const window = {
    addEventListener(type: string, handler: (event: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)?.add(handler)
    },
    removeEventListener(type: string, handler: (event: unknown) => void) {
      listeners.get(type)?.delete(handler)
    },
  } as unknown as Window
  const fire = (type: string, event: unknown) => {
    for (const handler of listeners.get(type) ?? []) handler(event)
  }
  return { window, fire }
}

function makeFakeWindow(): Window {
  return makeFakeWindowWithDispatch().window
}

describe('browser-log capture', () => {
  afterEach(() => {
    resetBrowserLogForTest()
  })

  it('redacts a secret before it reaches the buffer', () => {
    const fakeConsole = makeFakeConsole()
    const fakeWindow = makeFakeWindow()
    installBrowserLogCapture({ console: fakeConsole as unknown as Console, window: fakeWindow })

    fakeConsole.error(`Authorization: Bearer ${FAKE_BEARER_TOKEN}`)

    const [entry] = getBrowserLog().entries
    expect(entry?.text).toBeDefined()
    expect(entry?.text).not.toContain(FAKE_BEARER_TOKEN)
  })

  it('caps the buffer at 1000 entries and counts drops', () => {
    const fakeConsole = makeFakeConsole()
    installBrowserLogCapture({ console: fakeConsole as unknown as Console, window: makeFakeWindow() })

    for (let i = 0; i < 1005; i++) fakeConsole.log(`entry-${i}`)

    const log = getBrowserLog()
    expect(log.entries.length).toBe(1000)
    expect(log.dropped).toBe(5)
  })

  it('truncates a single entry to 8000 characters', () => {
    const fakeConsole = makeFakeConsole()
    installBrowserLogCapture({ console: fakeConsole as unknown as Console, window: makeFakeWindow() })

    fakeConsole.log('a'.repeat(9000))

    const [entry] = getBrowserLog().entries
    expect(entry?.text.length).toBeLessThanOrEqual(8000)
  })

  it('still calls through to the original console method', () => {
    const fakeConsole = makeFakeConsole()
    // installBrowserLogCapture reassigns fakeConsole.log to a wrapper, so the pre-install spy
    // reference is what proves the original was actually called through to.
    const originalLog = fakeConsole.log
    installBrowserLogCapture({ console: fakeConsole as unknown as Console, window: makeFakeWindow() })

    fakeConsole.log('hello')

    expect(originalLog).toHaveBeenCalledWith('hello')
  })

  it('does not double-wrap console methods on a repeated install', () => {
    const fakeConsole = makeFakeConsole()
    const fakeWindow = makeFakeWindow()
    installBrowserLogCapture({ console: fakeConsole as unknown as Console, window: fakeWindow })
    installBrowserLogCapture({ console: fakeConsole as unknown as Console, window: fakeWindow })

    fakeConsole.log('once')

    expect(getBrowserLog().entries.length).toBe(1)
  })

  it('never breaks the original console call when stringify/redaction throws on a pathological argument', () => {
    const fakeConsole = makeFakeConsole()
    const originalLog = fakeConsole.log
    installBrowserLogCapture({ console: fakeConsole as unknown as Console, window: makeFakeWindow() })

    // JSON.stringify throws "circular structure" on this (caught internally, falls back to
    // String(value)), and String(value) then throws too: a null-prototype object has no inherited
    // toString/valueOf. That second throw must not escape appendEntry or skip the original call.
    const cyclic = Object.create(null) as Record<string, unknown>
    cyclic.self = cyclic

    expect(() => fakeConsole.log('before', cyclic)).not.toThrow()
    expect(originalLog).toHaveBeenCalledWith('before', cyclic)
  })

  it('keeps the Error message when the stack does not already include it (Safari/Firefox-style stacks)', () => {
    const fakeConsole = makeFakeConsole()
    installBrowserLogCapture({ console: fakeConsole as unknown as Console, window: makeFakeWindow() })

    const err = new Error('distinctive-failure-message')
    err.stack = 'frame1@app.js:1:1\nframe2@app.js:2:2' // no message text in this stack

    fakeConsole.error(err)

    const [entry] = getBrowserLog().entries
    expect(entry?.text).toContain('distinctive-failure-message')
  })

  it('captures window error and unhandledrejection events into the buffer', () => {
    const fakeConsole = makeFakeConsole()
    const { window: fakeWindow, fire } = makeFakeWindowWithDispatch()
    installBrowserLogCapture({ console: fakeConsole as unknown as Console, window: fakeWindow })

    fire('error', { message: 'window-error-message', filename: 'app.js', lineno: 3, colno: 4, error: null })
    fire('unhandledrejection', { reason: 'rejection-reason' })

    const log = getBrowserLog()
    expect(log.entries.length).toBe(2)
    expect(log.entries[0]?.text).toContain('window-error-message')
    expect(log.entries[1]?.text).toContain('Unhandled promise rejection')
    expect(log.entries[1]?.text).toContain('rejection-reason')
  })
})
