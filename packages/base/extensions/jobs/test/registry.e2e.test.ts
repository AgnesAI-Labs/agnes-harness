import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { createShellTool } from '../../tools-core/src/tools/shell.js'
import { createJobTools } from '../src/index.js'
import { legacyProcess } from '../src/legacy-process.js'
import { ShellJobs } from '../src/registry.js'

const context = (sessionKey = 'jobs') => {
  const ctx = fakeToolContext({ cwd: tmpdir(), sessionKey, timeoutMs: 1000 })
  ctx.sandbox.confine = async (argv) => ['/bin/sh', ...argv.slice(1)]
  return ctx
}
describe.skipIf(process.platform === 'win32')('session shell jobs', () => {
  it('keeps the same job beyond the foreground timeout, isolates ownership, reads output and kills it', async () => {
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
      return handle
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
      await jobs.closeSession(ctx.session.key, ctx.session.lane)
      expect(jobs.list(ctx)).toEqual([])
    } finally {
      stopObserving?.()
      await jobs.dispose()
    }
  })
  it('launches explicit background jobs, adopts a repeated call and cleans running jobs on session end', async () => {
    const jobs = new ShellJobs()
    const ctx = context('close')
    try {
      const shell = createShellTool(jobs)
      expect((await shell.execute({ command: 'sleep 30', background: true }, ctx)).isError).toBeUndefined()
      await shell.execute({ command: 'sleep 30', background: true }, ctx)
      expect(jobs.list(ctx)).toHaveLength(1)
      await jobs.closeSession(ctx.session.key)
      expect(jobs.list(ctx)).toEqual([])
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
