import { describe, expect, it, vi } from 'vitest'
import { runIsolatedCommand } from '../src/process.js'

const NONEXISTENT_COMMAND = 'agnes-package-isolation-command-does-not-exist-xyz'

describe('runIsolatedCommand', () => {
  it('resolves with captured stdout on a normal exit', async () => {
    const result = await runIsolatedCommand('node', ['-e', "process.stdout.write('hi')"], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    })
    expect(result.stdout).toBe('hi')
  })

  it('rejects with the exit status when the command exits non-zero', async () => {
    await expect(
      runIsolatedCommand('node', ['-e', 'process.exit(3)'], {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5000,
        maxOutputBytes: 1024,
      }),
    ).rejects.toThrow(/exited with status 3/)
  })

  it('rejects immediately without spawning when the signal starts already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      runIsolatedCommand('node', ['-e', ''], {
        cwd: process.cwd(),
        env: process.env,
        signal: controller.signal,
        timeoutMs: 5000,
        maxOutputBytes: 1024,
      }),
    ).rejects.toThrow(/aborted/)
  })

  it('terminates and rejects a command that runs past its timeout', async () => {
    await expect(
      runIsolatedCommand('node', ['-e', 'setTimeout(() => {}, 5000)'], {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 50,
        maxOutputBytes: 1024,
      }),
    ).rejects.toThrow(/timed out/)
  })

  it('terminates and rejects a command whose output exceeds the byte limit', async () => {
    await expect(
      runIsolatedCommand('node', ['-e', "process.stdout.write('x'.repeat(1000))"], {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5000,
        maxOutputBytes: 10,
      }),
    ).rejects.toThrow(/exceeded limit/)
  })

  it('terminates a running command when its signal aborts mid-flight', async () => {
    const controller = new AbortController()
    const promise = runIsolatedCommand('node', ['-e', 'setTimeout(() => {}, 5000)'], {
      cwd: process.cwd(),
      env: process.env,
      signal: controller.signal,
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    })
    setTimeout(() => controller.abort(), 20)
    await expect(promise).rejects.toThrow(/aborted/)
  })

  it('escalates to SIGKILL when a command ignores SIGTERM past the grace window', async () => {
    const controller = new AbortController()
    const promise = runIsolatedCommand(
      'node',
      ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 5000)"],
      {
        cwd: process.cwd(),
        env: process.env,
        signal: controller.signal,
        timeoutMs: 5000,
        maxOutputBytes: 1024,
      },
    )
    setTimeout(() => controller.abort(), 20)
    await expect(promise).rejects.toThrow(/aborted/)
  }, 3000)

  // PKG-01: a spawn failure (e.g. ENOENT) leaves child.pid undefined for the life of the
  // ChildProcess object. The prior implementation's `child.pid ?? 0` fallback turned a
  // terminate() that raced in before the async 'error' event into `process.kill(-0, signal)` --
  // POSIX treats pid 0 as "this process's own group", so it signaled the *caller's* entire
  // process group instead of the (nonexistent) child. process.kill is mocked here so a
  // regression cannot actually deliver a real signal to this test worker.
  it('never signals the caller process group when a spawn failure races an abort', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const controller = new AbortController()
      const promise = runIsolatedCommand(NONEXISTENT_COMMAND, [], {
        cwd: process.cwd(),
        env: process.env,
        signal: controller.signal,
        timeoutMs: 5000,
        maxOutputBytes: 1024,
      })
      // Fires synchronously, before Node's async 'error' event for the failed spawn -- this is
      // the exact race the defect required: terminate() runs while child.pid is still undefined.
      controller.abort()
      await expect(promise).rejects.toThrow(/aborted/)
      expect(killSpy).not.toHaveBeenCalled()
    } finally {
      killSpy.mockRestore()
    }
  })

  it.skipIf(process.platform === 'win32')(
    'still signals the real process group by negative pid once a child has actually spawned',
    async () => {
      // No mock implementation: the real signal must actually reach the real child so its process
      // exits and the promise settles. This spy only observes the call args.
      const killSpy = vi.spyOn(process, 'kill')
      try {
        const controller = new AbortController()
        const promise = runIsolatedCommand('node', ['-e', 'setTimeout(() => {}, 5000)'], {
          cwd: process.cwd(),
          env: process.env,
          signal: controller.signal,
          timeoutMs: 5000,
          maxOutputBytes: 1024,
        })
        setTimeout(() => controller.abort(), 20)
        await expect(promise).rejects.toThrow(/aborted/)
        expect(killSpy).toHaveBeenCalled()
        for (const call of killSpy.mock.calls) {
          const pid = call[0] as number
          expect(pid).toBeLessThan(0)
        }
      } finally {
        killSpy.mockRestore()
      }
    },
  )
})
