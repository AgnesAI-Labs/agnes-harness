import { expect, it } from 'vitest'
import { FakeRuntime, runtimeContract } from '../src/runtime/testkit.js'
import { deferred, settles } from '../src/runtime/testkit-utils.js'

runtimeContract('scripted test double (not Python)', async () => new FakeRuntime(), {
  echo: 'echo',
  expectedOutput: 'runtime-contract-ok',
  call: 'call',
  wait: 'wait',
  expectedFrame: { jsonrpc: '2.0', id: 1, method: 'bridge.test', params: { marker: 42 } },
  persistent: { define: 'define', read: 'read', name: 'answer', expectedOutput: '42' },
})

it('prevents a cancelled script from making a late bridge call', async () => {
  let lateCall: ((frame: unknown) => Promise<unknown>) | undefined
  const entered = deferred<void>()
  const held = deferred<void>()
  const rt = new FakeRuntime({
    script: async (_program, call) => {
      lateCall = call
      entered.resolve(undefined)
      await held.promise
      return {}
    },
  })
  await rt.start({ cwd: '/w', env: {}, confine: async (argv) => argv })
  let calls = 0
  const running = rt.run({
    program: 'x',
    limits: { wallMs: 1000, maxOutputChars: 100 },
    bindings: async () => {
      calls++
      return null
    },
  })
  try {
    await settles(entered.promise)
    await rt.interrupt()
    expect((await settles(running)).status).toBe('aborted')
    if (!lateCall) throw new Error('script did not start')
    await expect(lateCall({})).rejects.toThrow()
    expect(calls).toBe(0)
  } finally {
    held.resolve(undefined)
    await rt.kill()
  }
})
