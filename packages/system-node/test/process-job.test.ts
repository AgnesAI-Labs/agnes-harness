import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { createWindowsProcessJob, windowsProcessStartTimeSync } from '../src/index.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function controlled() {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
      const { spawn } = require('node:child_process');
      process.on('message', action => {
        if (action === 'exit') process.exit(0);
        if (action === 'spawn') {
          const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'],
            { detached: true, windowsHide: true, stdio: 'ignore' });
          descendant.once('spawn', () => process.send({ pid: descendant.pid }));
          descendant.once('error', error => process.send({ error: error.code }));
        }
      });
      process.send('ready');
    `,
    ],
    { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  )
  const closed = once(child, 'close')
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  })
  expect((await once(child, 'message'))[0]).toBe('ready')
  const pid = child.pid as number
  const start = windowsProcessStartTimeSync(pid)
  expect(start).toBeTypeOf('string')
  return { child, pid, start: start as string, closed }
}

async function descendant(child: ChildProcess): Promise<number> {
  const response = once(child, 'message')
  child.send('spawn')
  const [message] = await response
  expect(message).toEqual({ pid: expect.any(Number) })
  return message.pid as number
}

function job() {
  const value = createWindowsProcessJob()
  cleanup.push(() => value.close())
  return value
}

describe.skipIf(process.platform !== 'win32')('Windows process job handles', () => {
  it('terminates a gated process and its detached descendant without touching a sibling', async () => {
    const root = await controlled()
    const sibling = await controlled()
    const owned = job()
    owned.assign(root.pid, root.start)
    expect(owned.terminationComplete()).toBe(false)
    const pid = await descendant(root.child)
    await expect.poll(() => owned.activeProcessCount()).toBe(2)
    expect(windowsProcessStartTimeSync(pid)).toBeTypeOf('string')
    owned.terminate()
    await expect.poll(() => owned.terminationComplete()).toBe(true)
    await root.closed
    expect(windowsProcessStartTimeSync(pid)).toBeNull()
    expect(windowsProcessStartTimeSync(sibling.pid)).toBe(sibling.start)
  })

  it('retains the descendant after its root exits and closes the entire remaining job', async () => {
    const root = await controlled()
    const owned = job()
    owned.assign(root.pid, root.start)
    const pid = await descendant(root.child)
    root.child.send('exit')
    await root.closed
    await expect.poll(() => owned.activeProcessCount()).toBe(1)
    expect(windowsProcessStartTimeSync(pid)).toBeTypeOf('string')
    owned.close()
    owned.close()
    await expect.poll(() => windowsProcessStartTimeSync(pid)).toBeNull()
    expect(() => owned.activeProcessCount()).toThrow('closed')
  })

  it('refuses an identity mismatch before assignment and leaves that process alive', async () => {
    const root = await controlled()
    const owned = job()
    expect(() => owned.assign(root.pid, String(BigInt(root.start) + 1n))).toThrow('identity changed')
    expect(owned.activeProcessCount()).toBe(0)
    owned.terminate()
    expect(windowsProcessStartTimeSync(root.pid)).toBe(root.start)
    expect(() => owned.assign(root.pid, root.start)).toThrow('terminated')
    owned.close()
    expect(() => owned.assign(root.pid, root.start)).toThrow('closed')
  })

  it('rejects invalid arguments, self-assignment and forged method receivers', () => {
    const owned = job()
    for (const pid of [0, -1, 1.5, NaN, 0x100000000, process.pid])
      expect(() => owned.assign(pid, '1')).toThrow()
    expect(() => owned.assign.call({} as never, 1, '1')).toThrow('receiver')
    expect(() => owned.close.call({} as never)).toThrow('receiver')
    expect(owned.activeProcessCount()).toBe(0)
    owned.close()
    owned.close()
    expect(() => owned.terminate()).toThrow('closed')
    expect(() => owned.terminationComplete()).toThrow('closed')
  })

  it('reaps the assigned process when the job owner is forcibly terminated', async () => {
    const module = new URL('../src/index.ts', import.meta.url).href
    const owner = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
        import { spawn } from 'node:child_process';
        import { createWindowsProcessJob, windowsProcessStartTimeSync } from ${JSON.stringify(module)};
        const job = createWindowsProcessJob();
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'],
          { detached: true, windowsHide: true, stdio: 'ignore' });
        child.once('spawn', () => {
          job.assign(child.pid, windowsProcessStartTimeSync(child.pid));
          process.send({ pid: child.pid });
        });
        process.on('message', () => job.activeProcessCount());
      `,
      ],
      { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    )
    const closed = once(owner, 'close')
    cleanup.push(async () => {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL')
      await closed
    })
    const [message] = await once(owner, 'message')
    expect(message).toEqual({ pid: expect.any(Number) })
    expect(windowsProcessStartTimeSync(message.pid)).toBeTypeOf('string')
    owner.kill('SIGKILL')
    await closed
    await expect.poll(() => windowsProcessStartTimeSync(message.pid)).toBeNull()
  })
})
