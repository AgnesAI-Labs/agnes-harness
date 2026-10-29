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
          { cwd: request.cwd ?? ctx.cwd, ...(request.signal ? { signal: request.signal } : {}) },
        )
      const tool = createShellTool(jobs)
      let call = 0
      const run = (command: string, extra = {}) => {
        Object.assign(ctx.session, { toolUseId: `win-${call++}` })
        return tool.execute({ command, ...extra }, ctx)
      }
      try {
        const ordinary = await run(
          "[Console]::Write('中文' + $PSVersionTable.PSVersion.Major); [Console]::Write((Join-Path $env:LOCALAPPDATA 'AgnesAudit')); exit 7",
        )
        expect(ordinary.isError).toBe(true)
        expect(JSON.stringify(ordinary)).toContain(version === '7' ? '中文7' : '中文5')
        expect(ordinary.details).toMatchObject({ code: 7 })
        expect(JSON.stringify(ordinary)).toContain(
          JSON.stringify('C:\\synthetic\\local appdata\\AgnesAudit').slice(1, -1),
        )
        const streams = await run(
          "Write-Host '中文 host'; Write-Warning '中文 warning'; [Console]::Write($env:PYTHONUTF8 + ':' + $env:PYTHONUNBUFFERED)",
        )
        expect(streams.isError, JSON.stringify(streams)).toBeUndefined()
        expect(JSON.stringify(streams)).toContain('中文 host')
        expect(JSON.stringify(streams)).toContain('中文 warning')
        expect(JSON.stringify(streams)).toContain('1:1')
        expect(JSON.stringify(streams)).not.toContain('CLIXML')
        const first = await run(
          "$kept = '变量中文'; [Console]::Write($kept); [Console]::Write($env:LOCALAPPDATA)",
          { persistent: true },
        )
        expect(first.isError, JSON.stringify(first)).toBeUndefined()
        expect(JSON.stringify(first)).toContain(JSON.stringify('C:\\synthetic\\local appdata').slice(1, -1))
        const next = await run('[Console]::Write($kept)', { persistent: true })
        expect(next.isError, JSON.stringify(next)).toBeUndefined()
        expect(JSON.stringify(next)).toContain('变量中文')
        expect(next.details).toMatchObject({ sessionId: (first.details as { sessionId: string }).sessionId })
        const long = await run("[Console]::Write('" + '中'.repeat(16000) + "')")
        expect(long.isError, JSON.stringify(long).slice(-500)).toBeUndefined()
        // A successful tool call is aborted by Core's finally; an owned background Job must survive it.
        const callSignal = new AbortController()
        ctx.signal = callSignal.signal
        const background = await run("Start-Sleep -Milliseconds 300; [Console]::Write('survived')", {
          background: true,
        })
        expect(background.isError).toBeUndefined()
        callSignal.abort()
        const id = (background.details as { jobId: string }).jobId
        ctx.signal = new AbortController().signal
        const done = await jobs.wait(ctx, id, 15000)
        expect(done).toMatchObject({ status: 'completed', stdout: 'survived' })
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
