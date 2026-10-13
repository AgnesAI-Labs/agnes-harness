import { runInNewContext } from 'node:vm'
import type { ToolContext } from '@agnes/extension-api'
import type { ExtensionAPI } from '@agnes/extension-api/host'
import { extensionFactoryOf } from '@agnes/plugin-runtime/bundled'
import { expect, it, vi } from 'vitest'
import pluginCreator, { pluginCreatorTools } from '../src/index.js'

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
    expect(pkg.agnes.plugins[0].apiRange).toBe('^4.0.0')
  }
  expect(exec).not.toHaveBeenCalled()
})
it('reads the bundled creator skill without executing commands and fails closed without the host port', async () => {
  const exec = vi.fn(),
    ctx = { signal: new AbortController().signal, exec } as unknown as ToolContext
  const result = await pluginCreatorTools[0].execute({}, ctx)
  expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('scriptedModel') })
  const guide = (result.content[0] as { text: string }).text
  expect(guide).toContain('8 KiB')
  expect(guide).toContain('After OUTPUT_LIMIT')
  expect(pluginCreatorTools[4].description).toContain('run_code')
  let sections: { content: string }[] = []
  extensionFactoryOf(pluginCreator)({
    registerTool: () => () => {},
    registerHook: (_name: string, hook: () => { sections: { content: string }[] }) => {
      sections = hook().sections
      return () => {}
    },
  } as unknown as ExtensionAPI)
  expect(sections[0]?.content).toContain('8 KiB')
  expect(sections[0]?.content).toContain('OUTPUT_LIMIT')
  // Execute the shipped bounded-edit example against the real tools and a synthetic author port.
  const candidateId = `candidate-${'a'.repeat(32)}`,
    candidateHash = `sha256-${'b'.repeat(64)}`
  const sourceFiles = [
    { path: 'package.json', content: '{"name":"example"}' },
    { path: 'skills/example/SKILL.md', content: '# Example\n<!-- next-section -->\n' },
    { path: 'untouched.md', content: 'Unchanged text '.repeat(2000) },
  ]
  let saved = sourceFiles
  const writable = {
    ...ctx,
    pluginManage: {
      request: async (input: unknown) => {
        const args = input as {
          action: string
          candidateId: string
          expectedHash?: string
          files: typeof sourceFiles
        }
        expect(args.candidateId).toBe(candidateId)
        if (args.action === 'candidate.show') return { candidateId, candidateHash, sourceFiles }
        expect(args.action).toBe('candidate.write')
        expect(args.expectedHash).toBe(candidateHash)
        saved = args.files
        return { candidateId, candidateHash: `sha256-${'c'.repeat(64)}`, sourceFiles: saved }
      },
    },
  } as ToolContext
  const program = guide.match(/```ts\n([\s\S]*?)\n```/)?.[1]?.replace('CANDIDATE_ID', candidateId)
  expect(program).toBeDefined()
  expect(program!.length).toBeLessThan(8192)
  const tools = {
    plugin_candidate_read: (args: { candidateId: string }) => pluginCreatorTools[5].execute(args, writable),
    plugin_candidate_write: (args: {
      candidateId: string
      expectedHash: string
      files: typeof sourceFiles
    }) => pluginCreatorTools[4].execute(args, writable),
  }
  expect(await runInNewContext(`(async () => {${program}})()`, { tools })).toEqual({
    candidateId,
    candidateHash: `sha256-${'c'.repeat(64)}`,
  })
  expect(saved).toEqual([
    sourceFiles[0],
    { path: sourceFiles[1]!.path, content: '# Example\nA complete small section.\n' },
    sourceFiles[2],
  ])
  expect(await pluginCreatorTools[1].execute({ template: 'skill', name: 'review-demo' }, ctx)).toMatchObject({
    isError: true,
  })
  expect(exec).not.toHaveBeenCalled()
})
