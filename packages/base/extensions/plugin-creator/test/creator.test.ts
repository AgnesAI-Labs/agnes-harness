import type { ToolContext } from '@agnes/extension-api'
import { expect, it, vi } from 'vitest'
import { pluginCreatorTools } from '../src/index.js'

it('submits only an exact candidate hash through the host, propagates refusal and cancellation, and never executes an install', async () => {
  const exec = vi.fn(),
    request = vi.fn(async () => {
      throw new Error('Passing tests required')
    })
  const ac = new AbortController()
  const ctx = { exec, signal: ac.signal, pluginManage: { request } } as unknown as ToolContext
  const args = { candidateId: 'candidate-' + 'a'.repeat(32), expectedHash: 'sha256-' + 'b'.repeat(64) }
  expect(pluginCreatorTools[3].meta.requiresApproval).toBe('always')
  await expect(pluginCreatorTools[3].execute(args, ctx)).rejects.toThrow('Passing tests required')
  expect(request).toHaveBeenCalledWith({ action: 'candidate.submit', ...args })
  expect(exec).not.toHaveBeenCalled()
  ac.abort(new DOMException('Stopped', 'AbortError'))
  await expect(pluginCreatorTools[3].execute(args, ctx)).rejects.toThrow('Stopped')
  expect(request).toHaveBeenCalledOnce()
})
it('scaffolds complete inert text through the host rather than reading virtual assets as generated files', async () => {
  const request = vi.fn(async (value: unknown) => value),
    exec = vi.fn()
  const ctx = {
    signal: new AbortController().signal,
    pluginManage: { request },
    exec,
  } as unknown as ToolContext
  for (const template of [
    'tool',
    'tool-with-panel',
    'mcp-skills',
    'model-adapter',
    'loop',
    'skill',
  ] as const) {
    await pluginCreatorTools[1].execute(
      { template, name: 'review-demo', directory: '/untrusted/discovery/root' },
      ctx,
    )
    const input = request.mock.calls.at(-1)?.[0] as {
      action: string
      files: { path: string; content: string }[]
    }
    expect(input.action).toBe('candidate.create')
    expect(input.files.some((f) => /\.test\.mjs$/.test(f.path))).toBe(true)
    const pkg = JSON.parse(input.files.find((f) => f.path === 'package.json')!.content)
    expect(pkg.name).toBe('review-demo')
    expect(pkg.agnes.plugins[0].apiRange).toBe('^1.4.0')
  }
  expect(exec).not.toHaveBeenCalled()
})
it('reads the bundled creator skill without executing commands and fails closed without the host port', async () => {
  const exec = vi.fn(),
    ctx = { signal: new AbortController().signal, exec } as unknown as ToolContext
  const result = await pluginCreatorTools[0].execute({}, ctx)
  expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('scriptedModel') })
  expect(await pluginCreatorTools[1].execute({ template: 'skill', name: 'review-demo' }, ctx)).toMatchObject({
    isError: true,
  })
  expect(exec).not.toHaveBeenCalled()
})
