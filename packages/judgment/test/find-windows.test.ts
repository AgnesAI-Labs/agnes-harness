import { expect, it } from 'vitest'
import { findWindows } from '../src/uses/find-windows.js'

it('keeps complete original lines within 8 KiB and original line coordinates', () => {
  const text = `${'a'.repeat(4095)}\n${'b'.repeat(4095)}\nneedle\ntail\n`
  const windows = findWindows(text, 'needle')
  expect(windows[0]).toMatchObject({
    startLine: 3,
    endLine: 4,
    start: 8192,
    end: 8204,
    fragment: false,
    text: 'needle\ntail\n',
  })
  expect(windows.every((w) => new TextEncoder().encode(w.text).length <= 8192)).toBe(true)
})

it('splits long UTF-8 lines without broken code points and caps selected windows at 24', () => {
  const windows = findWindows('界'.repeat(100000), '界')
  expect(windows).toHaveLength(24)
  expect(windows[0]).toMatchObject({ startLine: 1, endLine: 1, start: 0, end: 2730, fragment: true })
  expect(windows[0]?.text).toBe('界'.repeat(2730))
  expect(
    windows.every((w) => !w.text.includes('\uFFFD') && new TextEncoder().encode(w.text).length <= 8192),
  ).toBe(true)
})

it('redacts full source context before clipping summaries or line fragments', () => {
  const secret = `password="${'hidden-'.repeat(3000)}"\nneedle safe\n`
  const windows = findWindows(secret, 'hidden')
  expect(windows[1]?.start).toBe(8192)
  for (const window of windows) {
    expect(window.text).not.toContain('hidden')
    expect(window.summary).not.toContain('hidden')
    expect(window.summary.length).toBeLessThanOrEqual(256)
    expect(window.text.length).toBeLessThanOrEqual(window.end - window.start)
  }
  expect(windows.at(-1)?.text).toContain('needle safe')
})

it('does not pull characters beyond original 256-character summary after shrinking a secret', () => {
  const source = `token=${'s'.repeat(300)}\nDO-NOT-PULL-INTO-SUMMARY\n`
  const [window] = findWindows(source, 'token')
  expect(window?.summary).not.toContain('DO-NOT-PULL')
  expect(window?.summary).not.toContain('ssss')
  expect(window?.summary.length).toBeLessThanOrEqual(256)
})

it('selects the 24 most relevant windows with deterministic ties in source order', () => {
  const text = Array.from(
    { length: 30 },
    (_, i) => `${i === 29 ? 'needle' : 'plain'} ${String(i).padStart(2, '0')}${'x'.repeat(8181)}\n`,
  ).join('')
  const windows = findWindows(text, 'needle')
  expect(windows).toHaveLength(24)
  expect(windows[0]?.startLine).toBe(30)
  expect(windows[1]?.startLine).toBe(1)
  expect(windows[23]?.startLine).toBe(23)
})
