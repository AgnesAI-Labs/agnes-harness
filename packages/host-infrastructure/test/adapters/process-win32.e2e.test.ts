import type { ChildProcess } from 'node:child_process'
import { tracingChannel } from 'node:diagnostics_channel'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeToolContext } from '@agnes/base/testkit'
import { SHELL_STDIN_SENTINEL } from '@agnes/extension-api'
import { windowsProcessStartTimeSync } from '@agnes/system-node'
import { describe, expect, it, vi } from 'vitest'
import { ShellJobs } from '../../../base/extensions/jobs/src/registry.js'
import { createShellTool } from '../../../base/extensions/tools-core/src/tools/shell.js'
import { createExec } from '../../src/adapters/exec.js'
import { resolveConfiguredPowerShell } from '../../src/adapters/powershell.js'
import { powerShellCommand } from '../../src/adapters/powershell-command.js'
import * as powerShellFiles from '../../src/adapters/powershell-file.js'
import { expandShell } from '../../src/sandbox-seam.js'

describe.skipIf(process.platform !== 'win32')('Windows configured job shells', () => {
  it('cleans a real command tree even when another job reports a cleanup error', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agh-shutdown-error-'))
    const marker = join(cwd, 'descendant.pid')
    const failure = new Error('injected script cleanup failure')
    const prepare = powerShellFiles.preparePowerShellFile
    const injected = vi.spyOn(powerShellFiles, 'preparePowerShellFile').mockImplementationOnce((...args) => {
      const prepared = prepare(...args)
      return {
        ...prepared,
        dispose() {
          prepared.dispose()
          throw failure
        },
      }
    })
    const exec = createExec({ windowsNodeExecutable: process.execPath })
    const abort = new AbortController()
    let running: ReturnType<typeof exec.run> | undefined
    try {
      const job = await exec.openProcess!([process.execPath, '-e', 'process.exit(0)'], { cwd })
      expect((await job.exited).error).toBeInstanceOf(AggregateError)
      running = exec.run(
        [
          process.execPath,
          '-e',
          `
        const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { detached:true, stdio:'ignore' });
        child.once('spawn',()=>require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(child.pid)));
        setTimeout(()=>{},60000);
      `,
        ],
        { cwd, signal: abort.signal },
      )
      await expect.poll(() => readFile(marker, 'utf8'), { timeout: 10000 }).toMatch(/^\d+$/)
      const pid = Number(await readFile(marker, 'utf8'))
      expect(windowsProcessStartTimeSync(pid)).not.toBeNull()
      const cleanupError = await exec.killAll().then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(windowsProcessStartTimeSync(pid)).toBeNull()
      expect(cleanupError).toMatchObject({ errors: [expect.objectContaining({ errors: [failure] })] })
      expect(await running).toMatchObject({ signal: 'SIGKILL', timedOut: false })
    } finally {
      abort.abort()
      await running
      await exec.killAll().catch(() => undefined) // The injected failure remains observable on repeated close.
      injected.mockRestore()
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30000)
  it.each(['close', 'exit'] as const)(
    'cleans descendants after %s and joins repeated close',
    async (mode) => {
      const exec = createExec({ windowsNodeExecutable: process.execPath })
      const handle = await exec.openProcess!(
        [
          process.execPath,
          '-e',
          `
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { detached:true, stdio:'ignore' });
      child.once('spawn',()=>console.log(child.pid));
      process.stdin.once('data',()=>process.exit(0));
    `,
        ],
        { cwd: tmpdir() },
      )
      try {
        let output = ''
        handle.onOutput((chunk) => {
          if (chunk.stream === 'stdout') output += chunk.text
        })
        await expect.poll(() => output.trim(), { timeout: 10000 }).toMatch(/^\d+$/)
        const pid = Number(output.trim())
        expect(windowsProcessStartTimeSync(pid)).not.toBeNull()
        if (mode === 'exit') await handle.write('exit\n')
        else await handle.close()
        const exited = await handle.exited
        expect(exited.error).toBeUndefined()
        if (mode === 'exit') expect(exited.stoppedProcesses).toBeGreaterThanOrEqual(1)
        expect(windowsProcessStartTimeSync(pid)).toBeNull()
        await handle.close()
      } finally {
        await exec.killAll()
      }
    },
    30000,
  )
  it.each(['5.1', '7', 'custom'])(
    'runs ordinary and persistent jobs through selected PowerShell %s',
    async (version) => {
      const selected =
        version === 'custom'
          ? (await resolveConfiguredPowerShell({ ...process.env, AGNES_POWERSHELL: '5.1' })).path
          : version
      const shell = await resolveConfiguredPowerShell({ ...process.env, AGNES_POWERSHELL: selected })
      vi.stubEnv('LOCALAPPDATA', 'C:\\synthetic\\local appdata')
      const exec = createExec({ windowsNodeExecutable: process.execPath, windowsPowerShell: shell })
      const jobs = new ShellJobs()
      const base = fakeToolContext({ cwd: tmpdir(), timeoutMs: 20000 })
      const ctx = { ...base, platform: { ...base.platform, shell: 'powershell' as const } }
      ctx.sandbox.openProcess = (request) =>
        exec.openProcess!(
          request.argv[0] === SHELL_STDIN_SENTINEL
            ? [...request.argv]
            : expandShell([...request.argv], 'powershell', (s) => powerShellCommand(shell, s)),
          {
            cwd: request.cwd ?? ctx.cwd,
            ...(request.argv[0] === SHELL_STDIN_SENTINEL ? {} : { stdin: '' }),
            ...(request.signal ? { signal: request.signal } : {}),
          },
        )
      const tool = createShellTool(jobs)
      let call = 0
      const run = (command: string, extra = {}) => {
        Object.assign(ctx.session, { toolUseId: `win-${call++}` })
        return tool.execute({ command, ...extra }, ctx)
      }
      const precedingStepMs: number[] = []
      // A foreground receipt can be running. Join that exact job, then read its idempotent result.
      const runCompleted = async (command: string, extra = {}) => {
        const startedAt = performance.now()
        const receipt = await run(command, extra)
        const id = (receipt.details as { jobId: string }).jobId
        expect(typeof id, JSON.stringify(receipt)).toBe('string')
        const terminal = await jobs.wait(ctx, id, 15000)
        expect(terminal.status, JSON.stringify(terminal)).not.toBe('running')
        const before = jobs.list(ctx).map((job) => job.id)
        const result = await tool.execute({ command, ...extra }, ctx)
        expect(result.details).toMatchObject({ jobId: id, code: terminal.code, status: terminal.status })
        expect(jobs.list(ctx).map((job) => job.id)).toEqual(before)
        precedingStepMs.push(Math.round(performance.now() - startedAt))
        return result
      }
      try {
        const ordinary = await runCompleted(
          "[Console]::Write('中文' + $PSVersionTable.PSVersion.Major); [Console]::Write((Join-Path $env:LOCALAPPDATA 'AgnesAudit')); exit 7",
        )
        expect(ordinary.isError).toBe(true)
        expect(JSON.stringify(ordinary)).toContain(version === '7' ? '中文7' : '中文5')
        expect(ordinary.details).toMatchObject({ code: 7 })
        expect(JSON.stringify(ordinary)).toContain(
          JSON.stringify('C:\\synthetic\\local appdata\\AgnesAudit').slice(1, -1),
        )
        const streams = await runCompleted(
          "Write-Host '中文 host'; Write-Warning '中文 warning'; [Console]::Write($env:PYTHONUTF8 + ':' + $env:PYTHONUNBUFFERED)",
        )
        expect(streams.isError, JSON.stringify(streams)).toBeUndefined()
        expect(JSON.stringify(streams)).toContain('中文 host')
        expect(JSON.stringify(streams)).toContain('中文 warning')
        expect(JSON.stringify(streams)).toContain('1:1')
        expect(JSON.stringify(streams)).not.toContain('CLIXML')
        const first = await runCompleted(
          "$kept = '变量中文'; [Console]::Write($kept); [Console]::Write($env:LOCALAPPDATA)",
          { persistent: true },
        )
        expect(first.isError, JSON.stringify(first)).toBeUndefined()
        expect(JSON.stringify(first)).toContain(JSON.stringify('C:\\synthetic\\local appdata').slice(1, -1))
        const next = await runCompleted('[Console]::Write($kept)', { persistent: true })
        expect(next.isError, JSON.stringify(next)).toBeUndefined()
        expect(JSON.stringify(next)).toContain('变量中文')
        expect(next.details).toMatchObject({ sessionId: (first.details as { sessionId: string }).sessionId })
        const long = await runCompleted("[Console]::Write('" + '中'.repeat(16000) + "')")
        expect(long.isError, JSON.stringify(long).slice(-500)).toBeUndefined()
        // A successful tool call is aborted by Core's finally; an owned background Job must survive it.
        const callSignal = new AbortController()
        ctx.signal = callSignal.signal
        const traceStarted = performance.now()
        const events: Array<Record<string, unknown>> = []
        let broker: ChildProcess | undefined
        let brokerCount = 0
        let observerFailed = false
        let targetPid: number | undefined
        let targetStart: string | null | undefined
        const record = (event: string, details = {}) => {
          try {
            events.push({ event, elapsedMs: Math.round(performance.now() - traceStarted), ...details })
            if (events.length > 32) events.shift()
          } catch {
            observerFailed = true
          }
        }
        const onSpawn = () => record('broker-spawn', { pid: broker?.pid })
        const onMessage = (raw: unknown) => {
          try {
            const message = raw as { type?: unknown; pid?: unknown; code?: unknown; signal?: unknown } | null
            // These are broker IPC milestones; started acknowledges native spawn, not PowerShell script entry.
            if (message?.type === 'ready') record('ready')
            else if (
              message?.type === 'started' &&
              Number.isSafeInteger(message.pid) &&
              Number(message.pid) > 0
            ) {
              targetPid = Number(message.pid)
              record('started', { pid: targetPid })
              targetStart = windowsProcessStartTimeSync(targetPid)
            } else if (message?.type === 'exit') {
              record('target-exit', {
                code: message.code === null || Number.isInteger(message.code) ? message.code : null,
                signalPresent: typeof message.signal === 'string',
              })
            }
          } catch {
            observerFailed = true
          }
        }
        const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
          record('broker-exit', { code, signal })
        const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
          record('broker-close', { code, signal })
        const onSpawned = (raw: unknown) => {
          try {
            brokerCount++
            if (broker) return
            broker = (raw as { process: ChildProcess }).process
            // Node publishes tracing end before assigning pid/stdio; read them only on later events.
            broker.on('spawn', onSpawn)
            broker.on('message', onMessage)
            broker.on('exit', onExit)
            broker.on('close', onClose)
          } catch {
            observerFailed = true
          }
        }
        const streamState = (stream: ChildProcess['stdout']) =>
          stream && {
            bytesRead:
              'bytesRead' in stream && typeof stream.bytesRead === 'number' ? stream.bytesRead : null,
            readableLength: stream.readableLength,
            readableEnded: stream.readableEnded,
            closed: stream.closed,
            destroyed: stream.destroyed,
          }
        const targetIdentity = () => {
          if (targetPid === undefined || targetStart === undefined) return 'unobserved'
          if (targetStart === null) return 'initially-unavailable'
          try {
            return windowsProcessStartTimeSync(targetPid) === targetStart ? 'same' : 'gone-or-replaced'
          } catch {
            return 'lookup-failed'
          }
        }
        const spawnTrace = tracingChannel('child_process.spawn')
        if (version === '5.1') spawnTrace.end.subscribe(onSpawned)
        try {
          const background = await run("Start-Sleep -Milliseconds 300; [Console]::Write('survived')", {
            background: true,
          })
          record('receipt')
          expect(background.isError).toBeUndefined()
          callSignal.abort()
          record('call-aborted')
          const id = (background.details as { jobId: string }).jobId
          ctx.signal = new AbortController().signal
          const readerSignal = ctx.signal
          const waitStarted = performance.now()
          const done = await jobs.wait(ctx, id, 15000)
          record('wait-returned')
          if (done.status !== 'completed' || done.stdout !== 'survived') {
            console.error(
              'AGH_WINDOWS_BACKGROUND_WAIT',
              JSON.stringify({
                waitRequestedMs: 15000,
                waitElapsedMs: Math.round(performance.now() - waitStarted),
                jobId: id,
                sameJobId: done.id === id,
                status: done.status,
                code: done.code,
                signal: done.signal ?? null,
                stdoutBytes: Buffer.byteLength(done.stdout),
                stderrBytes: Buffer.byteLength(done.stderr),
                truncated: done.truncated,
                originalCallAborted: callSignal.signal.aborted,
                readerAborted: readerSignal.aborted,
                sameReaderSignal: ctx.signal === readerSignal,
                precedingStepMs: {
                  ordinary: precedingStepMs[0],
                  streams: precedingStepMs[1],
                  persistentFirst: precedingStepMs[2],
                  persistentNext: precedingStepMs[3],
                  long: precedingStepMs[4],
                },
                ...(version === '5.1'
                  ? {
                      brokerCount,
                      observerFailed,
                      events,
                      targetIdentity: targetIdentity(),
                      brokerStdout: streamState(broker?.stdout ?? null),
                      brokerStderr: streamState(broker?.stderr ?? null),
                      stdinWritableFinished: broker?.stdin?.writableFinished ?? null,
                    }
                  : {}),
              }),
            )
          }
          expect(done).toMatchObject({ status: 'completed', stdout: 'survived' })
        } finally {
          if (version === '5.1') spawnTrace.end.unsubscribe(onSpawned)
          broker?.off('spawn', onSpawn)
          broker?.off('message', onMessage)
          broker?.off('exit', onExit)
          broker?.off('close', onClose)
        }
        const running = await run('Start-Sleep -Seconds 60', { timeoutMs: 20 })
        expect(running.isError).toBeUndefined()
        await jobs.kill(ctx, (running.details as { jobId: string }).jobId)
        const foreground = new AbortController()
        ctx.signal = foreground.signal
        const cancelling = run("Write-Output 'cancel-ready'; Start-Sleep -Seconds 60", { timeoutMs: 15000 })
        await expect
          .poll(() => jobs.list(ctx).find((job) => job.stdout.includes('cancel-ready'))?.status, {
            timeout: 10000,
          })
          .toBe('running')
        foreground.abort()
        expect((await cancelling).isError).toBe(true)
        expect(jobs.list(ctx).find((job) => job.stdout.includes('cancel-ready'))?.status).toBe('killed')
      } finally {
        await jobs.dispose()
        await exec.killAll()
        vi.unstubAllEnvs()
      }
    },
    90000,
  )
})
