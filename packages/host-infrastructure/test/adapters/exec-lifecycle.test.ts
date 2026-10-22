import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({ spawn: vi.fn(), stop: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mocked.spawn,
}))
vi.mock('../../src/adapters/process-group.js', () => ({ stopProcessGroup: mocked.stop }))

import { createExec } from '../../src/adapters/exec.js'

afterEach(() => vi.resetAllMocks())
it('cleans descendants on leader exit before pipe close and returns the measured cleanup', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(),
  })
  mocked.spawn.mockReturnValue(child)
  mocked.stop.mockReturnValue(2)
  const exec = createExec()
  let serving = true
  const running = exec.run(['fixture'], {
    cwd: '/work',
    onExit: () => {
      serving = false
    },
  })
  child.stdout.write('ready')
  child.emit('exit', 0, null)
  expect(serving).toBe(false)
  child.emit('close', 0, null)
  expect(await running).toMatchObject({ code: 0, stdout: 'ready', timedOut: false, stoppedProcesses: 2 })
  await exec.killAll()
})
it('surfaces cleanup failure even when the leader exited successfully', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(),
  })
  mocked.spawn.mockReturnValue(child)
  mocked.stop.mockImplementation(() => {
    throw new Error('cleanup refused')
  })
  const exec = createExec({ killTree: () => undefined })
  const running = exec.run(['fixture'], { cwd: '/work' })
  child.emit('exit', 0, null)
  child.emit('close', 0, null)
  await expect(running).rejects.toThrow('cleanup refused')
})
