import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { startWindowsJobProcess } from '@agnes/system-node/process-spawn'
import { createPlatform, type PlatformBackend } from '../../adapters/platform.js'
import { defaultProcessIdentity } from '../../adapters/process-identity-default.js'
import { PosixDescendantTracker, PosixRootGroupOwner } from './posix-process-tree.js'

export type OwnedFakeProcess = Readonly<{
  pid: number
  stdin: Writable
  stdout: Readable
  stderr: Readable
  completion: Promise<Readonly<{ error?: Error }>>
  captureDescendants(): Promise<void>
  terminate(signal: 'SIGTERM' | 'SIGKILL'): Promise<void>
  waitForTreeExit(timeoutMs: number): Promise<boolean>
}>

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function posixProcess(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  platform: Pick<PlatformBackend, 'os'>,
): Promise<OwnedFakeProcess> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command, [...args], {
        detached: true,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }

    let started = false
    let completed = false
    let complete: (result: Readonly<{ error?: Error }>) => void = () => undefined
    const completion = new Promise<Readonly<{ error?: Error }>>((done) => {
      complete = done
    })
    const finish = (error?: Error) => {
      if (completed) return
      completed = true
      complete(error ? { error } : {})
    }
    // Installed before inspecting pid or awaiting spawn: ENOENT otherwise becomes an unhandled
    // ChildProcess error after the caller has already thrown for an undefined pid.
    child.once('error', (error) => {
      if (!started) reject(error)
      finish(error)
    })
    child.once('close', () => finish())
    child.once('spawn', () => {
      started = true
      const pid = child.pid
      if (pid === undefined) {
        const error = new Error('fake Computer Use child spawned without a pid')
        reject(error)
        finish(error)
        return
      }
      void (async () => {
        const identity = await defaultProcessIdentity(pid, platform)
        if (completed || identity.state === 'dead')
          throw new Error('fake Computer Use child exited before its process identity was captured')
        if (identity.state === 'unknown')
          throw new Error(`fake Computer Use cannot identify root process ${pid}: ${identity.reason}`)
        const group = new PosixRootGroupOwner(pid, identity.startId, platform)
        const descendants = new PosixDescendantTracker(pid, identity.startId, platform)
        resolve({
          pid,
          stdin: child.stdin,
          stdout: child.stdout,
          stderr: child.stderr,
          completion,
          captureDescendants: () => descendants.capture(),
          async terminate(signal) {
            const failures: unknown[] = []
            try {
              await descendants.capture()
            } catch (error) {
              failures.push(error)
            }
            // Once the root identity is gone or changed, its numeric PID/PGID is unsafe to signal.
            // Individually captured descendants retain their own start identities and remain safe.
            try {
              await group.signal(signal)
            } catch (error) {
              failures.push(error)
            }
            try {
              await descendants.signal(signal)
            } catch (error) {
              failures.push(error)
            }
            if (failures.length)
              throw new AggregateError(failures, `fake Computer Use ${signal} cleanup was incomplete`)
          },
          async waitForTreeExit(timeoutMs) {
            const deadline = Date.now() + timeoutMs
            for (;;) {
              if (!(await group.alive()) && (await descendants.allExited())) return true
              if (Date.now() >= deadline) return false
              await delay(10)
            }
          },
        })
      })().catch((error: unknown) => {
        reject(error)
        // The ChildProcess has not completed, so its pid cannot yet have been recycled. This is the
        // one safe cleanup window when identity capture itself failed.
        if (!completed) {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            child.kill('SIGKILL')
          }
        }
      })
    })
  })
}

export async function startOwnedFakeProcess(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<OwnedFakeProcess> {
  if (signal.aborted) throw new DOMException('fake Computer Use process start cancelled', 'AbortError')
  const platform = createPlatform()
  if (platform.os !== 'win32') return posixProcess(command, args, env, platform)

  const child = await startWindowsJobProcess([command, ...args], {
    cwd: process.cwd(),
    env: { ...env },
    nodeExecutable: process.execPath,
    signal,
  })
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    completion: child.completion.then((result) => (result.error ? { error: result.error } : {})),
    captureDescendants: async () => undefined,
    terminate: async () => child.terminate(),
    async waitForTreeExit(timeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const completed = await Promise.race([
        child.completion.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs)
        }),
      ])
      if (timer) clearTimeout(timer)
      return completed
    },
  }
}
