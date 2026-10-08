import { AsyncLocalStorage } from 'node:async_hooks'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import type { ExtensionAPI } from '@agnes/extension-api'
import { afterEach, expect, it, vi } from 'vitest'
import {
  type IsolatedHooksRunner,
  isolatedHooksRunnerFactory,
} from '../../src/ext-host/hooks-isolation-client.js'
import { connectExtensionRunner } from '../../src/ext-host/runner-transport.js'

const children: ChildProcessWithoutNullStreams[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
      child.kill('SIGKILL')
      await closed
    }
  }
})
const bootstrap = {
  nonce: 'test',
  extensionId: 'acme/test',
  packageDigest: 'p',
  manifestDigest: 'm',
  data: {},
}
const testNodeEnvironment = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}
function child(extra: string, hello = true) {
  const p = spawn(
    process.execPath,
    [
      '-e',
      `
    const send = m => {const b=Buffer.from(JSON.stringify({protocol:1,...m}));const h=Buffer.alloc(4);h.writeUInt32BE(b.length);process.stdout.write(Buffer.concat([h,b]))};
    let b=Buffer.alloc(0); process.stdin.on('data', c=>{b=Buffer.concat([b,c]);while(b.length>=4&&b.length>=4+b.readUInt32BE(0)){const n=b.readUInt32BE(0);const m=JSON.parse(b.subarray(4,4+n));b=b.subarray(4+n);handle(m)}});
    ${extra}
    ${hello ? "send({kind:'hello',nonce:'test',pid:process.pid});" : ''}
  `,
    ],
    { env: testNodeEnvironment, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  children.push(p)
  return p
}
const ready = "if(m.kind==='prepare')send({kind:'ready',events:[]});"
it('rejects calls during close and waits for a child ignoring TERM to be killed', async () => {
  const p = child(
    `process.on('SIGTERM',()=>{}); function handle(m){${ready} if(m.kind==='close')setTimeout(()=>send({kind:'closed'}),30)}`,
  )
  const runner = await connectExtensionRunner(p, bootstrap, async () => undefined)
  const close = runner.close()
  await expect(runner.invoke('test', {}, {}, new AbortController().signal)).rejects.toThrow('closing')
  await close
  expect(() => process.kill(runner.pid, 0)).toThrow()
})
it('does not send an invocation whose signal was already aborted', async () => {
  const p = child(
    `let count=0; function handle(m){${ready} if(m.kind==='invoke')send({kind:'result',requestId:m.requestId,value:++count}); if(m.kind==='close')process.exit(0)}`,
  )
  const runner = await connectExtensionRunner(p, bootstrap, async () => undefined)
  await expect(runner.invoke('test', {}, {}, AbortSignal.abort())).rejects.toThrow('already cancelled')
  expect(await runner.invoke('test', {}, {}, new AbortController().signal)).toBe(1)
  await runner.close()
})
it.each(['hello', 'ready'])('reaps a child sending duplicate %s during handshake', async (kind) => {
  const p = child(
    `function handle(m){if(m.kind==='prepare'){send({kind:'ready',events:[]});send({kind:'${kind}',nonce:'test',pid:process.pid})}}`,
  )
  const runner = await connectExtensionRunner(p, bootstrap, async () => undefined).catch(() => undefined)
  if (runner) {
    await new Promise<void>((resolve) => runner.onFailure(() => resolve()))
    await runner.close()
  }
  expect(() => process.kill(p.pid as number, 0)).toThrow()
})
it('startup timeout waits for actual process exit', async () => {
  const p = child('function handle(){}', false)
  await expect(connectExtensionRunner(p, bootstrap, async () => undefined, 30)).rejects.toThrow(
    'startup timed out',
  )
  expect(() => process.kill(p.pid as number, 0)).toThrow()
})
it('capability dispatch retains the calling Host async authority', async () => {
  const scope = new AsyncLocalStorage<string>()
  const p = child(
    `let id; function handle(m){${ready} if(m.kind==='invoke'){id=m.requestId;send({kind:'capability',requestId:'c1',invocationId:id,method:'event',input:{}})} if(m.kind==='capability-result')send({kind:'result',requestId:id,value:m.value}); if(m.kind==='close')process.exit(0)}`,
  )
  const runner = await connectExtensionRunner(p, bootstrap, async () => scope.getStore())
  expect(
    await scope.run('authenticated', () => runner.invoke('test', {}, {}, new AbortController().signal)),
  ).toBe('authenticated')
  await runner.close()
})
it.each(['http.run', 'events.append'])(
  'does not complete an invocation result before an unawaited %s capability settles',
  async (method) => {
    const p = child(
      `function handle(m){${ready} if(m.kind==='invoke'){send({kind:'capability',requestId:'c1',invocationId:m.requestId,method:'${method}',input:{}});send({kind:'result',requestId:m.requestId,value:'done'})} if(m.kind==='close')process.exit(0)}`,
    )
    let entered!: () => void
    let finish!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const capability = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = () => resolve('capability-done')
          entered()
        }),
    )
    const runner = await connectExtensionRunner(p, bootstrap, capability)
    let settled = false
    const invocation = runner.invoke('test', {}, {}, new AbortController().signal).finally(() => {
      settled = true
    })

    await started
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    finish()
    await expect(invocation).resolves.toBe('done')
    expect(capability).toHaveBeenCalledWith(method, {}, expect.any(AbortSignal), expect.anything())
    await runner.close()
  },
)
it('duplicate capability id is refused before a second side effect', async () => {
  const p = child(
    `function handle(m){${ready} if(m.kind==='invoke'){const c={kind:'capability',requestId:'c1',invocationId:m.requestId,method:'event',input:{}};send(c);send(c)}}`,
  )
  const call = vi.fn(async () => new Promise(() => undefined))
  const runner = await connectExtensionRunner(p, bootstrap, call)
  await expect(runner.invoke('test', {}, {}, new AbortController().signal)).rejects.toThrow(
    'duplicate capability',
  )
  expect(call).toHaveBeenCalledOnce()
  await runner.close()
  expect(() => process.kill(runner.pid, 0)).toThrow()
})
it.each([true, false])(
  'always closes after a throwing registration disposer (partial=%s)',
  async (partial) => {
    const close = vi.fn(async () => undefined)
    const runner = {
      pid: 1,
      events: ['before_step', 'context'],
      close,
      invoke: vi.fn(),
      onFailure: () => () => {},
    } as unknown as IsolatedHooksRunner
    const disposed = vi.fn(() => {
      throw Error('cleanup failed')
    })
    let count = 0
    const api = {
      registerHook() {
        if (++count === 2 && partial) throw Error('registration failed')
        return disposed
      },
    } as unknown as ExtensionAPI
    const factory = isolatedHooksRunnerFactory(async () => runner)
    if (partial) await expect(factory(api)).rejects.toThrow('registration failed')
    else {
      const dispose = await factory(api)
      if (typeof dispose !== 'function') throw Error('missing disposer')
      await expect(dispose()).rejects.toThrow('cleanup failed')
      expect(disposed).toHaveBeenCalledTimes(2)
    }
    expect(close).toHaveBeenCalledOnce()
  },
)

it('does not publish a factory whose Runner failed before observer installation', async () => {
  const close = vi.fn(async () => undefined),
    dispose = vi.fn()
  const runner = {
    pid: 1,
    events: ['before_step'],
    invoke: vi.fn(),
    close,
    onFailure(callback: (error: Error) => void) {
      callback(Error('already failed'))
      return () => {}
    },
  } as unknown as IsolatedHooksRunner
  const api = { registerHook: () => dispose } as unknown as ExtensionAPI
  await expect(isolatedHooksRunnerFactory(async () => runner)(api)).rejects.toThrow('already failed')
  expect(dispose).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
})
