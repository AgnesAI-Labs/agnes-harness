import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { createShellTool } from '../../tools-core/src/tools/shell.js'
import { createJobTools } from '../src/index.js'
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
      expect(JSON.stringify(await output!.execute({ jobId: id }, ctx))).toContain('ready')
      expect((await output!.execute({ jobId: id }, context('other'))).isError).toBe(true)
      await kill!.execute({ jobId: id }, ctx)
      expect(jobs.list(ctx)[0]?.status).toBe('killed')
      await jobs.closeSession(ctx.session.key, ctx.session.lane)
      expect(jobs.list(ctx)).toEqual([])
    } finally {
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
