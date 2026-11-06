import { execFile, spawn } from 'node:child_process'
import { tracingChannel } from 'node:diagnostics_channel'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { observeMcpProcesses } from './child-process-observer.js'

// Capture the actual caller before subscribing, as mcp-sandbox does at module evaluation.
const execute = promisify(execFile)
const target = new Map([[process.execPath, 'runtime-inspection' as const]])

it('ignores unrelated executables with the fixed production-call filter', async () => {
  const observer = observeMcpProcesses()
  try {
    await expect(execute(process.execPath, ['-e', ''])).resolves.toMatchObject({ stdout: '', stderr: '' })
    expect(observer.events).toEqual([])
  } finally {
    observer.dispose()
  }
})

it.each([0, 7])('passively observes a real exit %s without changing output or failure', async (code) => {
  const observer = observeMcpProcesses(target)
  try {
    const pending = execute(process.execPath, [
      '-e',
      `process.stdout.write('PRIVATE_STDOUT'); process.stderr.write('PRIVATE_STDERR'); process.exitCode=${code}`,
    ])
    expect(pending.child.listenerCount('error')).toBe(1)
    expect(pending.child.stdout?.listenerCount('data')).toBe(1)
    expect(pending.child.stderr?.listenerCount('data')).toBe(1)
    if (code === 0)
      await expect(pending).resolves.toMatchObject({ stdout: 'PRIVATE_STDOUT', stderr: 'PRIVATE_STDERR' })
    else
      await expect(pending).rejects.toMatchObject({
        code,
        stdout: 'PRIVATE_STDOUT',
        stderr: 'PRIVATE_STDERR',
      })
    expect(observer.events).toEqual([
      { stage: 'runtime-inspection', attempt: 1, event: 'start', elapsedMs: 0 },
      {
        stage: 'runtime-inspection',
        attempt: 1,
        event: 'spawn',
        elapsedMs: expect.any(Number),
        pid: pending.child.pid,
      },
      {
        stage: 'runtime-inspection',
        attempt: 1,
        event: 'exit',
        elapsedMs: expect.any(Number),
        pid: pending.child.pid,
        code,
        signal: null,
        killed: false,
        stdoutBytes: expect.any(Number),
        stderrBytes: expect.any(Number),
      },
      {
        stage: 'runtime-inspection',
        attempt: 1,
        event: 'close',
        elapsedMs: expect.any(Number),
        pid: pending.child.pid,
        code,
        signal: null,
        killed: false,
        stdoutBytes: 14,
        stderrBytes: 14,
      },
    ])
    expect(JSON.stringify(observer.events)).not.toMatch(/PRIVATE_|spawnargs|options|env|"stdout":|"stderr":/)
  } finally {
    observer.dispose()
  }
})

it('records the actual spawn error without adding an error listener or changing rejection', async () => {
  const missing = join(tmpdir(), `agh-observer-missing-${process.pid}-${Date.now()}`)
  const observer = observeMcpProcesses(new Map([[missing, 'sandbox']]))
  try {
    const pending = execute(missing)
    expect(pending.child.listenerCount('error')).toBe(1)
    await expect(pending).rejects.toMatchObject({ code: 'ENOENT', path: missing })
    expect(observer.events).toEqual([
      { stage: 'sandbox', attempt: 1, event: 'start', elapsedMs: 0 },
      { stage: 'sandbox', attempt: 1, event: 'spawn-error', elapsedMs: expect.any(Number), code: 'ENOENT' },
    ])
    expect(JSON.stringify(observer.events)).not.toContain(missing)
  } finally {
    observer.dispose()
  }
})

it('preserves the caller timeout and records its actual killed exit', async () => {
  const observer = observeMcpProcesses(target)
  try {
    const pending = execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 100 })
    await expect(pending).rejects.toMatchObject({ killed: true, signal: 'SIGTERM' })
    expect(observer.events).toHaveLength(4)
    expect(observer.events[2]).toMatchObject({ event: 'exit', code: null, signal: 'SIGTERM', killed: true })
    expect(observer.events[3]).toMatchObject({ event: 'close', code: null, signal: 'SIGTERM', killed: true })
  } finally {
    observer.dispose()
  }
})

it('unsubscribes and detaches a still-running child without signalling it', async () => {
  const { start } = tracingChannel('child_process.spawn')
  const before = start.hasSubscribers
  const observer = observeMcpProcesses(target)
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  try {
    expect(child.listenerCount('exit')).toBe(1)
    expect(child.listenerCount('close')).toBe(1)
    expect(start.hasSubscribers).toBe(true)
    observer.dispose()
    observer.dispose()
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
    expect(child.killed).toBe(false)
    expect(start.hasSubscribers).toBe(before)
  } finally {
    const exited = once(child, 'exit')
    child.kill()
    await exited
    observer.dispose()
  }
  expect(observer.events).toEqual([{ stage: 'runtime-inspection', attempt: 1, event: 'start', elapsedMs: 0 }])
})
