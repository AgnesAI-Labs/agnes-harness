import { tmpdir } from 'node:os'
import { validateMethod } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { createShellTool } from '../../tools-core/src/tools/shell.js'
import { createJobTools } from '../src/index.js'
import { legacyProcess } from '../src/legacy-process.js'
import { ShellJobs } from '../src/registry.js'
import { createJobsServices } from '../src/services.js'

const context = (sessionKey = 'jobs') => {
  const ctx = fakeToolContext({ cwd: tmpdir(), sessionKey, timeoutMs: 1000 })
  ctx.sandbox.confine = async (argv) => ['/bin/sh', ...argv.slice(1)]
  return ctx
}
describe.skipIf(process.platform === 'win32')('session shell jobs', () => {
  it.each([undefined, 0, 2])(
    'keeps a real job beyond the timeout and projects cleanup receipt %s',
    async (stoppedProcesses) => {
      const jobs = new ShellJobs()
      const ctx = context()
      // The foreground deadline may elapse before the child gets scheduled. Observe actual output
      // before asserting its contents, while keeping the same real process and short deadline.
      let ready!: () => void
      const outputReady = new Promise<void>((resolve) => {
        ready = resolve
      })
      let stopObserving: (() => void) | undefined
      ctx.sandbox.openProcess = async ({ argv, cwd }) => {
        const handle = await legacyProcess(ctx, [...argv], cwd ?? ctx.cwd)
        stopObserving = handle.onOutput((chunk) => {
          if (chunk.stream === 'stdout' && chunk.text.includes('ready')) ready()
        })
        // The child is real; supply the optional receipt metadata reported by platform process ports.
        return {
          ...handle,
          exited: handle.exited.then((receipt) => ({
            ...receipt,
            ...(stoppedProcesses === undefined ? {} : { stoppedProcesses }),
          })),
        }
      }
      try {
        const result = await createShellTool(jobs).execute(
          { command: 'echo ready; sleep 30', timeoutMs: 10 },
          ctx,
        )
        expect(result.isError).toBeUndefined()
        expect(JSON.stringify(result)).toContain('same process continues')
        const id = jobs.list(ctx)[0]!.id
        const [list, output, kill] = createJobTools(jobs)
        expect(JSON.stringify(await list!.execute({}, ctx))).toContain(id)
        await outputReady
        expect(JSON.stringify(await output!.execute({ jobId: id }, ctx))).toContain('ready')
        expect((await output!.execute({ jobId: id }, context('other'))).isError).toBe(true)
        await kill!.execute({ jobId: id }, ctx)
        expect(jobs.list(ctx)[0]?.status).toBe('killed')
        expect(jobs.list(ctx)[0]?.stoppedProcesses).toBe(stoppedProcesses)
        const [read] = createJobsServices(jobs)
        const snapshot = await read!.handler({ jobId: id }, { ...ctx, source: 'test', requestId: 'r' })
        expect(validateMethod('_agnes/v1/session.jobs.read', 'result', snapshot)).toMatchObject({ ok: true })
        expect(snapshot).toMatchObject({
          jobs: [{ id, status: 'killed' }],
          completions: [{ id, status: 'killed' }],
          job: { id, stdout: expect.stringContaining('ready'), status: 'killed' },
        })
        await jobs.closeSession(ctx.session.key, ctx.session.lane)
        expect(jobs.list(ctx)).toEqual([])
      } finally {
        stopObserving?.()
        await jobs.dispose()
      }
    },
  )
  it('launches explicit background jobs, adopts a repeated call and cleans running jobs on session end', async () => {
    const jobs = new ShellJobs()
    const ctx = context('close')
    try {
      const shell = createShellTool(jobs)
      const started = await shell.execute({ command: 'sleep 30', background: true }, ctx)
      expect(started.isError).toBeUndefined()
      expect(started.structured).toEqual({ jobId: jobs.list(ctx)[0]!.id, status: 'running' })
      await shell.execute({ command: 'sleep 30', background: true }, ctx)
      expect(jobs.list(ctx)).toHaveLength(1)
      await jobs.closeSession(ctx.session.key)
      expect(jobs.list(ctx)).toEqual([])
    } finally {
      await jobs.dispose()
    }
  })
  // compile-compcert and install-windows-3.11: `nohup make &` in a foreground command was reaped
  // the moment its shell ended. Children the command backgrounds are now the job: the call returns
  // when the command's own shell is done, and they keep running under job_kill and session close.
  it('keeps what a command starts with & or nohup running as its job, and returns when the command ends', async () => {
    const jobs = new ShellJobs()
    const ctx = context('detached')
    ctx.sandbox.openProcess = async ({ argv, cwd }) => legacyProcess(ctx, [...argv], cwd ?? ctx.cwd)
    const shell = createShellTool(jobs)
    try {
      const started = Date.now()
      const r = await shell.execute({ command: 'nohup sleep 30 >/dev/null 2>&1 & echo started; exit 3' }, ctx)
      expect(Date.now() - started).toBeLessThan(900)
      const text = (r.content[0] as { text: string }).text
      expect(text).toContain('started')
      expect(text).toContain('[exit 3]')
      expect(text).toContain('keep running as background job')
      expect(text).not.toContain('AGH_FG')
      const [job] = jobs.list(ctx)
      expect(job).toMatchObject({ status: 'running', code: null })
      expect((await jobs.kill(ctx, job!.id)).status).toBe('killed')

      // An ordinary command is unchanged: its code, its output and nothing of the wrapper.
      Object.assign(ctx.session, { toolUseId: 'plain' })
      const plain = await shell.execute({ command: 'echo out; echo err >&2; false' }, ctx)
      expect((plain.content[0] as { text: string }).text).toMatch(/^out\n\n\[stderr\]\nerr\n/)
      expect(JSON.stringify(plain)).not.toContain('AGH_FG')
      expect(plain.details).toMatchObject({ status: 'failed', code: 1 })
    } finally {
      await jobs.dispose()
    }
  })
  it('says when a command ended its own shell with a signal', async () => {
    const jobs = new ShellJobs()
    const ctx = context('self-kill')
    ctx.sandbox.openProcess = async ({ argv, cwd }) => legacyProcess(ctx, [...argv], cwd ?? ctx.cwd)
    try {
      const r = await createShellTool(jobs).execute(
        { command: 'echo before; kill -TERM $$; echo after' },
        ctx,
      )
      const text = (r.content[0] as { text: string }).text
      expect(text).toContain("[the command's shell was ended by SIGTERM, which AGH did not send.")
      expect(text).not.toContain('after')
    } finally {
      await jobs.dispose()
    }
  })
  it('refuses before spawning if confinement is unavailable', async () => {
    const jobs = new ShellJobs()
    const ctx = context('deny')
    ctx.sandbox.confine = async () => {
      throw new Error('sandbox denied')
    }
    const result = await createShellTool(jobs).execute({ command: 'echo unsafe', background: true }, ctx)
    expect(result.isError).toBe(true)
    expect(jobs.list(ctx)).toEqual([])
  })
})

describe.skipIf(process.platform === 'win32')('persistent shells', () => {
  it.each(['bash', 'zsh'] as const)(
    'retains cwd, env and variables in %s; serializes jobs and kills busy commands',
    async (shell) => {
      const jobs = new ShellJobs()
      const ctx = context('persistent-' + shell)
      ctx.sandbox.confine = async (argv) => argv
      const command = createShellTool(jobs)
      let call = 0
      const run = async (text: string, extra = {}) => {
        Object.assign(ctx.session, { toolUseId: 'persistent-call-' + call++ })
        return command.execute({ command: text, persistent: true, shell, ...extra }, ctx)
      }
      try {
        const first = await run('cd /; export AGH_TEST_VALUE=kept; agh_local=local; printf first')
        expect(first.isError).toBeUndefined()
        const sessionId = (first.details as { sessionId: string }).sessionId
        const next = await run('printf "%s/%s/%s" "$PWD" "$AGH_TEST_VALUE" "$agh_local"')
        expect(JSON.stringify(next)).toContain('//kept/local')
        expect((next.details as { sessionId: string }).sessionId).toBe(sessionId)
        const invalidCwd = await run('printf should-not-run', { cwd: '/unreadable' })
        expect(invalidCwd.isError).toBe(true)
        const busy = await run('printf ready; sleep 30', { timeoutMs: 10 })
        expect(busy.isError).toBeUndefined()
        expect((await run('printf too-early')).isError).toBe(true)
        const jobId = (busy.details as { jobId: string }).jobId
        expect((await jobs.kill(ctx, jobId)).status).toBe('killed')
        expect(jobs.list(ctx).find((job) => job.id === sessionId)?.status).toBe('killed')
        expect(jobs.completions(ctx).some((job) => job.id === jobId)).toBe(true)
        expect((await run('echo fresh')).isError).toBeUndefined()
        await jobs.dispose()
        const reloaded = await run('printf "%s" "${AGH_TEST_VALUE-unset}"')
        expect(reloaded.isError).toBeUndefined()
        expect(JSON.stringify(reloaded)).toContain('unset')
        await expect(jobs.wait(context('foreign'), sessionId, 0)).rejects.toThrow('JOB_NOT_FOUND')
      } finally {
        await jobs.dispose()
      }
    },
  )
})
