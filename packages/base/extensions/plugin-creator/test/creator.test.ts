import { runInNewContext } from 'node:vm'
import { THEME_TOKEN_NAMES, type ToolContext } from '@agnes/extension-api'
import type { ExtensionAPI } from '@agnes/extension-api/host'
import { extensionFactoryOf } from '@agnes/plugin-runtime/bundled'
import type { AuthoringCandidate } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import pluginCreator, { pluginCreatorTools } from '../src/index.js'

it.each(['中文'.repeat(10_000), 'x'.repeat(3500)])(
  'returns candidate sources as program data, with a bounded display and short write receipt',
  async (content) => {
    const candidateId = `candidate-${'a'.repeat(32)}`,
      candidateHash = `sha256-${'b'.repeat(64)}`
    const sourceFiles = [{ path: 'large.md', content }]
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
  },
)

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
    expect(pkg.agnes.plugins[0].apiRange).toBe('^5.0.0')
    if (template === 'tool-with-panel') {
      const descriptor = JSON.parse(
        input.files.find((file) => file.path === 'client/agnes.client.json')!.content,
      )
      expect(descriptor.client.slots).toEqual([])
      expect(descriptor.client.lifetime).toBe('profile')
      expect(descriptor.client.homeEntries).toMatchObject([{ id: 'review-demo', placement: 'secondary' }])
      expect(pkg.agnes.plugins[0].capabilities.store).toBe(true)
      expect(input.files.some((file) => file.path === 'client/index.js')).toBe(true)
      expect(input.files.some((file) => file.path === 'test/panel.test.mjs')).toBe(true)
    }
    expect(pkg.agnes.plugins[0].inject).toEqual(
      {
        tool: ['tools'],
        'tool-with-panel': ['tools', 'services'],
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
  expect(pluginCreatorTools[4].description).toContain('mode: merge')
  let sections: { content: string }[] = []
  extensionFactoryOf(pluginCreator)({
    registerTool: () => () => {},
    registerHook: (_name: string, hook: () => { sections: { content: string }[] }) => {
      sections = hook().sections
      return () => {}
    },
  } as unknown as ExtensionAPI)
  expect(sections).toEqual([])
  const context = sections.map((section) => section.content).join('\n')
  expect(Buffer.byteLength(context, 'utf8')).toBeLessThanOrEqual(4096)
  expect(guide).toContain('plugin_helper_guide')
  expect(guide).toContain('plugin_creator_guide')
  for (const token of THEME_TOKEN_NAMES) {
    expect(context).not.toContain(token)
    expect(guide).toContain(token)
  }
  const { authorReference } = await import(
    new URL(
      '../../../../package-manager/bundled-plugins/plugin-helper/src/reference.generated.mjs',
      import.meta.url,
    ).href
  )
  expect(context).not.toContain(authorReference)
  expect(guide).toContain(authorReference)
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
          mode?: string
        }
        expect(args.candidateId).toBe(candidateId)
        if (args.action === 'candidate.show') return { candidateId, candidateHash, sourceFiles }
        expect(args.action).toBe('candidate.write')
        expect(args.expectedHash).toBe(candidateHash)
        expect(args.mode).toBe('merge')
        saved = args.files
        return { candidateId, candidateHash: `sha256-${'c'.repeat(64)}`, sourceFiles: saved }
      },
    },
  } as ToolContext
  const program = guide
    .match(/Minimal TypeScript cell pattern[\s\S]*?```ts\n([\s\S]*?)\n```/)?.[1]
    ?.replace('CANDIDATE_ID', candidateId)
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
  expect(saved).toEqual([{ path: sourceFiles[1]!.path, content: '# Example\nA complete small section.\n' }])
  expect(await pluginCreatorTools[1].execute({ template: 'skill', name: 'review-demo' }, ctx)).toMatchObject({
    isError: true,
  })
  expect(exec).not.toHaveBeenCalled()
})

it.each([
  ['PLUGIN_MANAGEMENT_UNAVAILABLE', 'unavailable-host-capability'],
  ['CAPABILITY_DENIED', 'permission-denied'],
  ['E_LEASE_EXPIRED', 'permission-denied'],
  ['E_WORKSPACE_UNTRUSTED', 'permission-denied'],
  ['PLUGIN_CANDIDATE_STALE', 'stale-hash'],
  ['E_PACKAGE_STATE', 'validation-failure'],
  ['E_PACKAGE_SOURCE', 'validation-failure'],
])('reports %s with its operation, stage and existing candidate', async (code, kind) => {
  const candidateId = `candidate-${'a'.repeat(32)}`
  const args = { candidateId, expectedHash: `sha256-${'b'.repeat(64)}` }
  const ctx = {
    signal: new AbortController().signal,
    pluginManage: {
      request: async () => {
        throw Object.assign(new Error('refused'), { code })
      },
    },
  } as unknown as ToolContext
  expect(await pluginCreatorTools[3].execute(args, ctx)).toMatchObject({
    isError: true,
    details: { code, kind, operation: 'candidate.submit', stage: 'request', candidateId },
  })
  const withoutPort = { ...ctx }
  delete withoutPort.pluginManage
  expect(await pluginCreatorTools[3].execute(args, withoutPort)).toMatchObject({
    isError: true,
    details: {
      kind: 'unavailable-host-capability',
      operation: 'candidate.submit',
      stage: 'host-capability',
      candidateId,
    },
  })
})

it('keeps the created draft and reports write as the failing operation without inventing an admin switch', async () => {
  const tools = new Map<string, import('@agnes/extension-api').ToolDef>()
  const { pluginHelper } = await import(
    new URL('../../../../package-manager/bundled-plugins/plugin-helper/index.mjs', import.meta.url).href
  )
  pluginHelper.apply({
    tools: { register: (tool: import('@agnes/extension-api').ToolDef) => tools.set(tool.name, tool) },
  })
  const candidateId = `candidate-${'a'.repeat(32)}`,
    candidateHash = `sha256-${'b'.repeat(64)}`
  const sourceFiles = [{ path: 'package.json', content: '{}' }]
  const ctx = {
    signal: new AbortController().signal,
    session: { depth: 0 },
    pluginManage: {
      request: async (input: { action: string; candidateId?: string }) => {
        if (input.action === 'candidate.create')
          return { candidateId, candidateHash, state: 'draft', tests: null }
        expect(input).toMatchObject({ action: 'candidate.write', candidateId })
        throw Object.assign(new Error('unavailable'), { code: 'PLUGIN_MANAGEMENT_UNAVAILABLE' })
      },
    },
  } as unknown as ToolContext
  const helperGuide = tools.get('plugin_helper_guide'),
    helperCreate = tools.get('plugin_helper_create')
  if (!helperGuide || !helperCreate) throw new Error('Missing helper tools')
  const guide = await helperGuide.execute({ kind: 'skin' }, ctx)
  expect(guide.structured).toMatchObject({ authoringCapability: 'supplied-authorization-checked-per-call' })
  const text = JSON.stringify(guide)
  for (const instruction of [
    'Continue the same draft',
    'operation, stage and candidateId',
    'never invent settings/switches',
    'CLI executable/version',
    'agh plugins pack',
    'present',
  ])
    expect(text).toContain(instruction)
  const created = await helperCreate.execute({ files: sourceFiles }, ctx)
  expect(created).toMatchObject({
    structured: {
      candidateId,
      state: 'draft',
      operation: 'candidate.create',
      verification: { draftGenerated: 'verified', installVerified: 'not-verified' },
    },
  })
  const written = await pluginCreatorTools[4].execute(
    { candidateId, expectedHash: candidateHash, files: sourceFiles },
    ctx,
  )
  expect(written).toMatchObject({
    isError: true,
    structured: {
      operation: 'candidate.write',
      stage: 'request',
      candidateId,
      kind: 'unavailable-host-capability',
    },
  })
  expect(JSON.stringify(written.content)).toContain('keep the existing draft')
  expect(JSON.stringify(written.content)).not.toMatch(/admin|switch|create.*failed/i)
  const alias = tools.get('plugin_helper_write')!
  const delta = {
    candidateId,
    expectedHash: candidateHash,
    mode: 'merge',
    files: sourceFiles,
    remove: ['old.md'],
  }
  const requests: unknown[] = []
  const portContext = {
    ...ctx,
    pluginManage: {
      request: async (input: unknown) => {
        requests.push(input)
        return { candidateId, candidateHash, state: 'draft', tests: null }
      },
    },
  } as unknown as ToolContext
  for (const tool of [pluginCreatorTools[4], alias]) {
    const receipt = await tool.execute(delta, portContext)
    expect(receipt).toMatchObject({ structured: { candidateId, candidateHash } })
  }
  expect(requests).toEqual([
    { action: 'candidate.write', ...delta },
    { action: 'candidate.write', ...delta },
  ])
  expect(alias.parameters.required).toContain('expectedHash')
  const builtinGuide = await pluginCreatorTools[0].execute({}, ctx)
  const { authorReference } = await import(
    new URL(
      '../../../../package-manager/bundled-plugins/plugin-helper/src/reference.generated.mjs',
      import.meta.url,
    ).href
  )
  for (const kind of ['tool', 'tool-with-panel', 'skill', 'skin']) {
    const full = (await helperGuide.execute({ kind }, ctx)).structured as { authoringPath: string }
    expect(full.authoringPath).toContain(authorReference)
    for (const token of THEME_TOKEN_NAMES) expect(full.authoringPath).toContain(token)
    if (kind === 'tool-with-panel') {
      const panel = await helperGuide.execute({ kind }, ctx)
      const display = JSON.parse((panel.content[0] as { text: string }).text)
      expect(display.initialCandidate).toContain('plugin_scaffold({template:"tool-with-panel"')
      expect(display.initialCandidate).toContain('files:guide.files')
      expect(display.previewFiles.some((file: { path: string }) => file.path === 'package.json')).toBe(false)
      expect(
        (panel.structured as { files: { path: string }[] }).files.some(
          (file) => file.path === 'package.json',
        ),
      ).toBe(true)
    }
  }
  const helperData = guide.structured as { authoringPath: string }
  expect(JSON.stringify(builtinGuide.content)).toContain(
    JSON.stringify(helperData.authoringPath).slice(1, -1),
  )
})

it.each([
  { state: 'draft', tests: null, passed: false, installed: false },
  { state: 'tested', testHash: 'current', count: 1, passed: true, installed: false },
  { state: 'tested', testHash: 'old', count: 1, passed: false, installed: false },
  { state: 'tested', testHash: 'current', count: 0, passed: false, installed: false },
  { state: 'failed', testHash: 'current', count: 1, passed: false, installed: false },
  { state: 'review', testHash: 'current', count: 1, passed: true, installed: false },
  { state: 'publishing', testHash: 'current', count: 1, passed: true, installed: false },
  { state: 'published', testHash: 'current', count: 1, passed: true, installed: true },
])('reports verification evidence for $state without claiming browser appearance', async (row) => {
  const candidateId = `candidate-${'a'.repeat(32)}`,
    candidateHash = `sha256-${'b'.repeat(64)}`
  const value = {
    candidateId,
    candidateHash,
    state: row.state,
    tests: row.testHash
      ? {
          state: row.state === 'failed' ? 'failed' : 'passed',
          hash: row.testHash === 'current' ? candidateHash : `sha256-${'c'.repeat(64)}`,
          count: row.count,
        }
      : null,
    preview: row.state === 'review' || row.state === 'published' ? { blockers: [] } : null,
  } as unknown as AuthoringCandidate
  const ctx = {
    signal: new AbortController().signal,
    pluginManage: { request: async () => value },
  } as unknown as ToolContext
  const result = await pluginCreatorTools[2].execute({ candidateId, expectedHash: candidateHash }, ctx)
  const { verification } = await import(
    new URL('../../../../package-manager/bundled-plugins/plugin-helper/src/authoring.mjs', import.meta.url)
      .href
  )
  expect(result.structured).toMatchObject({
    verification: {
      draftGenerated: 'verified',
      structureValidated: value.preview ? 'verified' : 'not-verified',
      candidateTestPassed: row.passed ? 'verified' : 'not-verified',
      installVerified: row.installed ? 'verified' : 'not-verified',
      browserAppearanceVerified: 'not-verified',
      published: row.installed ? 'verified' : 'not-verified',
    },
  })
  expect((result.structured as { verification: unknown }).verification).toEqual(verification(value))
  expect(JSON.stringify(result.content)).toContain('check light/dark mode, disable and restore')
})

it('projects allowlisted validation diagnostics and redacted failing assertions into ordinary model text', async () => {
  const { authoringFailure } = await import('../src/authoring-error.js')
  const diagnostics = [
    {
      code: 'unknown-theme-token',
      path: 'client/agnes.client.json',
      field: 'skins.demo.tokens',
      name: '--agnes-text-muted',
      hint: '/' + 'Users' + '/private/unsafe',
      stack: 'raw stack',
    },
    { code: 'missing-required-file', path: 'package.json', field: 'files', name: 'package.json' },
    { code: 'invalid-field', path: '/' + 'Users' + '/private/package.json', field: 'secret', name: 'unsafe' },
  ]
  const rejected = authoringFailure('candidate.write', 'candidate-' + 'a'.repeat(32), 'request', {
    data: { reason: 'E_PACKAGE_STATE', diagnostics },
  })!
  const text = JSON.stringify(rejected.content)
  expect(text).toContain('unsupported token --agnes-text-muted')
  expect(text).toContain('complete file tree is missing package.json')
  expect(text).not.toMatch(/text-primary|text-secondary|\/Users|raw stack/)
  const candidateId = 'candidate-' + 'a'.repeat(32),
    candidateHash = 'sha256-' + 'b'.repeat(64)
  const value = {
    candidateId,
    candidateHash,
    state: 'failed',
    tests: {
      state: 'failed',
      hash: candidateHash,
      count: 1,
      output:
        'not ok 1 - retains schedule\n  error: expected 2 entries, got 0\n  name: AssertionError\n  location: ./test/schedule.test.mjs:7:3\n  private: /' +
        'Users' +
        '/private/customer/data.json\n' +
        'x'.repeat(20000),
    },
    diagnostics: [],
    sourceFiles: [],
  } as unknown as AuthoringCandidate
  const ctx = {
    signal: new AbortController().signal,
    pluginManage: { request: async () => value },
  } as unknown as ToolContext
  const result = await pluginCreatorTools[2].execute({ candidateId, expectedHash: candidateHash }, ctx)
  const failureText = JSON.stringify(result.content)
  for (const expected of [
    'retains schedule',
    'expected 2 entries, got 0',
    'AssertionError',
    'test/schedule.test.mjs:7:3',
    'tests.output',
    '[truncated]',
  ])
    expect(failureText).toContain(expected)
  expect(failureText).not.toContain('/' + 'Users' + '/private')
  expect(Buffer.byteLength(failureText)).toBeLessThan(6500)
  expect(JSON.stringify(result.structured)).not.toContain('/' + 'Users' + '/private')
  const read = await pluginCreatorTools[5].execute({ candidateId }, ctx)
  expect(read.structured).toMatchObject({ tests: { output: expect.stringContaining('AssertionError') } })
  for (const output of [
    'E_TOOLDEF_META: meta.replay: safe requires isReadOnly',
    'Test port not configured; supply options.context',
  ]) {
    value.tests!.output = output
    const failed = await pluginCreatorTools[2].execute({ candidateId, expectedHash: candidateHash }, ctx)
    const hint = JSON.stringify(failed.content)
    expect(hint).toContain('Repair hint')
    expect(hint).toContain("replay: 'never'")
    expect(hint).toContain("'default' is invalid")
    expect(hint).toContain('BOTH survive')
    expect(failed.isError).toBe(true)
  }
  value.tests!.state = 'passed'
  const passed = await pluginCreatorTools[2].execute({ candidateId, expectedHash: candidateHash }, ctx)
  expect(JSON.stringify(passed.content)).not.toContain('Repair hint')
  expect(JSON.stringify(passed.content)).not.toContain('AssertionError')
  value.tests = null
  value.state = 'draft'
  value.diagnostics = [
    {
      code: 'missing-required-file',
      path: 'package.json',
      field: 'exports',
      name: 'index.mjs',
      hint: 'restore',
    },
  ]
  value.writeSummary = {
    added: [],
    removed: ['index.mjs'],
    changed: [],
    entries: ['index.mjs'],
    missing: ['index.mjs'],
    unchanged: false,
  }
  const written = await pluginCreatorTools[4].execute(
    { candidateId, expectedHash: candidateHash, files: [] },
    ctx,
  )
  expect(JSON.stringify(written.content)).toContain('complete file tree is missing index.mjs')
  expect(written.structured).toMatchObject({ writeSummary: { removed: ['index.mjs'] } })
})
