import { expect, it } from 'vitest'
import { timingMark } from '../src/timing.js'

function marks(env: Record<string, string | undefined>, phases: string[]): string[] {
  const lines: string[] = []
  for (const phase of phases) timingMark(phase, env, (line) => lines.push(line))
  return lines
}

it('writes nothing unless AGH_TIMING is 1', () => {
  expect(marks({}, ['a'])).toEqual([])
  expect(marks({ AGH_TIMING: '0' }, ['a'])).toEqual([])
  expect(marks({ AGH_TIMING: 'true' }, ['a'])).toEqual([])
})

it('writes one monotonic line per phase, counted from the launcher origin when one is given', () => {
  const origin = performance.timeOrigin - 1000
  const lines = marks({ AGH_TIMING: '1', AGH_TIMING_ORIGIN: String(origin) }, ['a', 'b', 'c'])
  const parsed = lines.map((line) => /^agh-timing (\w) (\d+\.\d)\n$/.exec(line))
  expect(parsed.every((m) => m !== null)).toBe(true)
  const times = parsed.map((m) => Number(m?.[2]))
  expect(times[0]).toBeGreaterThanOrEqual(1000)
  expect([...times].sort((x, y) => x - y)).toEqual(times)
})
