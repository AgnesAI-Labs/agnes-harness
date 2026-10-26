import { expect, it } from 'vitest'
import { REPLACE_WAIT_MS, replacePublishedFileSync } from '../src/durable-replace.js'

const held = (code: string, forMs: number) => {
  const until = performance.now() + forMs
  let calls = 0
  return {
    rename: () => {
      calls++
      if (performance.now() < until) throw Object.assign(new Error(code), { code })
    },
    calls: () => calls,
  }
}

it('waits for a Windows reader that holds the destination for longer than 100 ms', () => {
  const reader = held('EPERM', 300)
  replacePublishedFileSync('a.tmp', 'a.json', true, reader.rename)
  expect(reader.calls()).toBeGreaterThan(1)
})

it('still refuses a destination that stays held, after the bound', () => {
  const reader = held('EACCES', 60_000)
  const started = performance.now()
  expect(() => replacePublishedFileSync('a.tmp', 'a.json', true, reader.rename)).toThrow('EACCES')
  expect(performance.now() - started).toBeGreaterThanOrEqual(REPLACE_WAIT_MS - 1)
})

it('does not retry off Windows or for other errors', () => {
  for (const [windows, code] of [
    [false, 'EPERM'],
    [true, 'ENOENT'],
  ] as const) {
    const reader = held(code, 60_000)
    expect(() => replacePublishedFileSync('a.tmp', 'a.json', windows, reader.rename)).toThrow(code)
    expect(reader.calls()).toBe(1)
  }
})
