import { runInNewContext } from 'node:vm'
import type { ToolContext } from '@agnes/extension-api'
import type { ExtensionAPI } from '@agnes/extension-api/host'
import { extensionFactoryOf } from '@agnes/plugin-runtime/bundled'
import { expect, it, vi } from 'vitest'
import pluginCreator, { pluginCreatorTools } from '../src/index.js'

it('returns large candidate sources as program data, with a bounded display and short write receipt', async () => {
  const candidateId = `candidate-${'a'.repeat(32)}`,
    candidateHash = `sha256-${'b'.repeat(64)}`
  const sourceFiles = [{ path: 'large.md', content: '中文'.repeat(10_000) }]
  const ctx = {
    signal: new AbortController().signal,
    outputMaxBytes: 4096,
    pluginManage: {
      request: async () => ({
        candidateId,
        candidateHash,
        sourceFiles,
        files: sourceFiles.map((f) => ({ path: f.path, before: null, after: f.content })),
      }),
    },
  } as unknown as ToolContext
  const read = await pluginCreatorTools[5].execute({ candidateId }, ctx)
  expect(read).toMatchObject({ structured: { candidateId, candidateHash, sourceFiles } })
  expect(Buffer.byteLength(JSON.stringify(read.content))).toBeLessThan(4096)
  const written = await pluginCreatorTools[4].execute(
    { candidateId, expectedHash: candidateHash, files: sourceFiles },
    ctx,
  )
  expect(JSON.stringify(written)).not.toContain(sourceFiles[0]!.content)
  expect(written).toMatchObject({ structured: { candidateId, candidateHash } })
})

it.each(['中文🙂'.repeat(9000), '\u0001'.repeat(120_000), '\ufeffA\r\nB\n"\\'.repeat(9000)])(
  'reads exact source bytes across pages and rejects invalid offsets and changed hashes',
  async (content) => {
    const candidateId = `candidate-${'a'.repeat(32)}`,
      candidateHash = `sha256-${'b'.repeat(64)}`
    const sourceFiles = [
      { path: 'source.txt', content },
      { path: 'empty.txt', content: '' },
    ]
    let hash = candidateHash
    const put = vi.fn(async (bytes: Uint8Array) => ({
      sha256: 'c'.repeat(64),
      size: bytes.length,
      mime: 'text/plain',
    }))
    const request = vi.fn(async () => ({ candidateId, candidateHash: hash, sourceFiles }))
    const ctx = {
      signal: new AbortController().signal,
      outputMaxBytes: 4096,
      artifacts: { put },
      pluginManage: { request },
    } as unknown as ToolContext
    let offset = 0,
      combined = '',
      total = 0
    for (let count = 0; count < 128; count++) {
      const result = await pluginCreatorTools[5].execute(
        { candidateId, offset, expectedHash: candidateHash },
        ctx,
      )
      expect(result.isError).not.toBe(true)
      expect(Buffer.byteLength(JSON.stringify(result.structured))).toBeLessThan(256 * 1024)
      expect(Buffer.byteLength(JSON.stringify(result.content))).toBeLessThan(4096)
      const page = result.structured as {
        kind: string
        offset: number
        data: string
        nextOffset: number | null
        totalBytes: number
      }
      expect(page.kind).toBe('candidate-source-page')
      expect(page.offset).toBe(offset)
      combined += page.data
      total = page.totalBytes
      if (page.nextOffset === null) break
      expect(page.nextOffset).toBe(offset + Buffer.byteLength(page.data))
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset
    }
    expect(Buffer.byteLength(combined)).toBe(total)
    expect(JSON.parse(combined)).toEqual({ candidateId, candidateHash, sourceFiles })
    expect(put).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith({ action: 'candidate.show', candidateId })
    expect(request).toHaveBeenLastCalledWith({ action: 'candidate.show', candidateId })
    for (const bad of [-1, 0.5, total + 1])
      expect(
        await pluginCreatorTools[5].execute({ candidateId, offset: bad, expectedHash: candidateHash }, ctx),
      ).toMatchObject({ isError: true })
    expect(await pluginCreatorTools[5].execute({ candidateId, offset: 1 }, ctx)).toMatchObject({
      isError: true,
    })
    const multi = Buffer.from(combined).findIndex((byte) => (byte & 0xc0) === 0x80)
    if (multi >= 0)
      expect(
        await pluginCreatorTools[5].execute({ candidateId, offset: multi, expectedHash: candidateHash }, ctx),
      ).toMatchObject({ isError: true })
    expect(
      (await pluginCreatorTools[5].execute({ candidateId, offset: total, expectedHash: candidateHash }, ctx))
        .structured,
    ).toMatchObject({ data: '', nextOffset: null })
    hash = `sha256-${'d'.repeat(64)}`
    expect(
      await pluginCreatorTools[5].execute({ candidateId, offset: 0, expectedHash: candidateHash }, ctx),
    ).toMatchObject({ isError: true, details: { code: 'E_PACKAGE_PREVIEW_STALE' } })
  },
)

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
    if (template === 'skill') {
      expect(pkg.agnes.plugins).toBeUndefined()
      expect(pkg.agnes.contributions).toEqual([
        { kind: 'skill', id: 'review-demo/main', path: './skills/review-demo/SKILL.md' },
      ])
      expect(input.files.some((file) => file.path === 'index.mjs')).toBe(false)
      continue
    }
    expect(pkg.agnes.plugins[0].apiRange).toBe('^4.0.0')
    expect(pkg.agnes.plugins[0].inject).toEqual(
      {
        tool: ['tools'],
        'tool-with-panel': ['tools'],
        'mcp-skills': ['skills'],
        'model-adapter': ['providers'],
        loop: ['tools', 'providers', 'skills'],
      }[template],
    )
    const entry = input.files.find((file) => /^(?:src\/)?index\.(?:ts|mjs)$/.test(file.path))
    expect(entry?.content).toBeDefined()
    expect(entry?.content).not.toMatch(/\binject\s*:/)
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
    plugin_candidate_read: async (args: { candidateId: string }) =>
      (await pluginCreatorTools[5].execute(args, writable)).structured,
    plugin_candidate_write: (args: {
      candidateId: string
      expectedHash: string
      files: typeof sourceFiles
    }) => pluginCreatorTools[4].execute(args, writable).then((result) => result.structured),
  }
  expect(await runInNewContext(`(async () => {${program}})()`, { tools, TextEncoder })).toEqual({
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
