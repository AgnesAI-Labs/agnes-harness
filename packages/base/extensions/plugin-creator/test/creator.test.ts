import type { ToolContext } from '@agnes/extension-api'
import { expect, it, vi } from 'vitest'
import { pluginCreatorTools } from '../src/index.js'

it('refuses installation after failed tests or cancellation through the normal tool port', async () => {
  const exec = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'test failure', truncated: false }))
  const ac = new AbortController()
  const ctx = {
    exec,
    signal: ac.signal,
    cwd: '/workspace',
    timeoutMs: 1000,
    platform: { shell: 'posix' },
  } as unknown as ToolContext
  const install = pluginCreatorTools[3]
  expect(install.meta.requiresApproval).toBe('always')
  expect(await install.execute({ directory: 'draft', name: 'hello' }, ctx)).toMatchObject({ isError: true })
  expect(exec.mock.calls).toEqual([[['npm', 'test'], { cwd: 'draft', timeoutMs: 1000 }]])
  ac.abort(new DOMException('Stopped', 'AbortError'))
  await expect(install.execute({ directory: 'draft', name: 'hello' }, ctx)).rejects.toThrow('Stopped')
})
it('reads the bundled creator skill without executing commands', async () => {
  const exec = vi.fn()
  const result = await pluginCreatorTools[0].execute({}, {
    signal: new AbortController().signal,
    exec,
  } as unknown as ToolContext)
  expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('scriptedModel') })
  expect(exec).not.toHaveBeenCalled()
})
