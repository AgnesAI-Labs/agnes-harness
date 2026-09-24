// `confirmResourceOperation` (execution.ts:18-27) is the only interactive gate in front of every
// mutating resource command (resources.ts:429, 461, 491, 519, 553, 662, 704).
//
// Oracle, independent of execution.ts: readline's own contract. `rl.question(query, cb)` invokes
// `cb` only on a submitted line; EOF closes the interface and Ctrl-C with no interface-level
// 'SIGINT' listener does the same, and neither calls `cb`. A promise that resolves only from
// inside that callback therefore never settles, and `runResourceCliCommand` awaits it inside a
// `try` whose `finally { await booted.close() }` (execution.ts:55-57) freezes with it.
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { confirmResourceOperation } from '../src/execution.js'

const HUNG = Symbol('confirm never settled')

/** Drives the real prompt on a fake TTY, then sends `keys`; `''` means EOF. */
async function ask(keys: string, tty = true) {
  let out = ''
  const stdin = Object.assign(new PassThrough(), { isTTY: tty, setRawMode() {} })
  const stdout = Object.assign(new PassThrough(), { isTTY: tty, columns: 80, rows: 24 })
  stdout.on('data', (b: Buffer) => {
    out += String(b)
  })
  const answered = confirmResourceOperation({ stdin, stdout }, 'delete resource r1 at revision 3')
  await new Promise((r) => setImmediate(r))
  if (keys === '') stdin.end()
  else stdin.write(keys)
  const settled = await Promise.race([
    answered,
    new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), 1_000)),
  ])
  return { settled: settled === HUNG ? 'hung' : settled, prompted: out.includes('Continue?') }
}

describe('confirmResourceOperation must settle when the operator declines to answer', () => {
  it('[control] answering "y" confirms the operation', async () => {
    expect(await ask('y\r')).toEqual({ settled: true, prompted: true })
  })

  // Preservation: the fix reorders resolve/close and adds a 'close' settlement, so the paths that
  // already worked have to be pinned down before it lands.
  it('[preserve] answering "n" declines the operation', async () => {
    expect(await ask('n\r')).toEqual({ settled: false, prompted: true })
  })

  it('[preserve] a non-TTY stream fails closed without ever prompting', async () => {
    expect(await ask('', false)).toEqual({ settled: false, prompted: false })
  })

  it('stdin EOF declines instead of hanging the command', async () => {
    expect(await ask('')).toEqual({ settled: false, prompted: true })
  })

  it('Ctrl-C declines instead of hanging the command', async () => {
    expect(await ask('\x03')).toEqual({ settled: false, prompted: true })
  })
})
