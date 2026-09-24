import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { windowsProcessStartTimeSync } from '@agnes/system-node'
import { afterEach, describe, expect, it } from 'vitest'
import { runIsolatedCommand } from '../src/process.js'

const roots: string[] = []
const active: Array<{ abort: AbortController; done: Promise<unknown> }> = []
afterEach(async () => {
  for (const task of active.splice(0)) {
    task.abort.abort()
    await task.done
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'agnes-isolated-中文 '))
  roots.push(cwd)
  return { cwd, env: { ...process.env }, timeoutMs: 5000, maxOutputBytes: 1024 }
}

describe.skipIf(process.platform !== 'win32')('bounded Windows package commands', () => {
  it('preserves Unicode/argv, drains ignored stderr and closes stdin', async () => {
    const options = setup()
    const result = await runIsolatedCommand(
      process.execPath,
      [
        '-e',
        `
      process.stderr.write('x'.repeat(100000));
      process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify(process.argv.slice(1))));
    `,
        '',
        '中文 "引用"',
        'a&b',
      ],
      options,
    )
    expect(JSON.parse(result.stdout)).toEqual(['', '中文 "引用"', 'a&b'])
  })

  it('retains exact byte limits and nonzero-exit errors', async () => {
    const options = { ...setup(), maxOutputBytes: 6 }
    expect(
      await runIsolatedCommand(process.execPath, ['-e', 'process.stdout.write("中文")'], options),
    ).toEqual({ stdout: '中文' })
    await expect(
      runIsolatedCommand(process.execPath, ['-e', 'process.stdout.write("中文x")'], options),
    ).rejects.toThrow('command output exceeded limit')
    await expect(runIsolatedCommand(process.execPath, ['-e', 'process.exit(7)'], options)).rejects.toThrow(
      'command exited with status 7',
    )
    await expect(runIsolatedCommand('agnes-no-such-command', [], options)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it.each(['cancel', 'timeout', 'overflow'])(
    'waits for every descendant before rejecting on %s',
    async (mode) => {
      const options = setup(),
        marker = join(options.cwd, 'pids'),
        abort = new AbortController()
      const code = `
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],
        {detached:true,windowsHide:true,stdio:'ignore'});
      child.once('spawn',()=>{
        require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid]));
        ${mode === 'overflow' ? "process.stdout.write('x'.repeat(10000))" : ''}
      });
      setTimeout(()=>{},15000);
    `
      const done = runIsolatedCommand(process.execPath, ['-e', code], {
        ...options,
        timeoutMs: mode === 'timeout' ? 1000 : 5000,
        maxOutputBytes: 16,
        signal: abort.signal,
      }).then(
        () => null,
        (error: unknown) => error,
      )
      active.push({ abort, done })
      await expect.poll(() => existsSync(marker)).toBe(true)
      if (mode === 'cancel') abort.abort()
      const failure = await done
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toBe(
        mode === 'cancel'
          ? 'command aborted'
          : mode === 'timeout'
            ? 'command timed out'
            : 'command output exceeded limit',
      )
      const pids = JSON.parse(readFileSync(marker, 'utf8')) as number[]
      expect(pids).toHaveLength(2)
      for (const pid of pids) expect(windowsProcessStartTimeSync(pid)).toBeNull()
    },
  )

  it('does not execute after cancellation before or during startup', async () => {
    const options = setup(),
      abort = new AbortController()
    const marker = join(options.cwd, 'must-not-exist')
    const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`
    const pending = runIsolatedCommand(process.execPath, ['-e', code], { ...options, signal: abort.signal })
    abort.abort()
    await expect(pending).rejects.toThrow('command aborted')
    await expect(
      runIsolatedCommand(process.execPath, ['-e', code], { ...options, signal: abort.signal }),
    ).rejects.toThrow('command aborted')
    expect(existsSync(marker)).toBe(false)
  })
})
