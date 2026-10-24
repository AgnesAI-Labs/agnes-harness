import { realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditTool } from '../../tools-core/src/tools/edit.js'
import { createWriteTool } from '../../tools-core/src/tools/write.js'
import { LspSessions } from '../src/registry.js'
import { fakeInstall, lspContext, sandboxHarness, sleep } from './harness.js'

const BAD = 'const x = BAD\n'
const TS = '/work/proj/a.ts'
const ok: string[] = []
let harness = sandboxHarness({})
let install = fakeInstall([])
afterEach(() => harness.killAll())

function setup(
  table: Record<string, string[]>,
  config: Parameters<LspSessions['configure']>[0] = {},
  withTypescript = true,
) {
  harness = sandboxHarness(table)
  install = fakeInstall(Object.keys(table), withTypescript)
  const lsp = harness.closing(new LspSessions())
  lsp.configure({
    searchPath: install.searchPath,
    stableMs: 20,
    autoWaitMs: 1500,
    toolWaitMs: 3000,
    ...config,
  })
  return lsp
}
const TSFAKE = { 'typescript-language-server': ok }

/** Edits until a cold server has started and answered. */
const until = (fn: () => Promise<string | undefined>) =>
  vi.waitFor(async () => expect(await fn()).toBeDefined(), 5000)

describe('automatic diagnostics', () => {
  it('skips the cold start, then reports the errors of the current text', async () => {
    const lsp = setup(TSFAKE)
    const ctx = lspContext(harness)
    expect(await lsp.diagnosticsFor(ctx, TS, BAD)).toBeUndefined()
    await until(() => lsp.diagnosticsFor(ctx, TS, BAD))
    expect(harness.opened).toHaveLength(1)
    expect(await lsp.diagnosticsFor(ctx, TS, 'const x = 1\nlet y = BAD\n')).toBe(
      'LSP found 1 error in a.ts:\n2:9 bad word on line 2 (fake F1)',
    )
    expect(await lsp.diagnosticsFor(ctx, TS, 'fine\n')).toBeUndefined()
    // The server is started once, at the project root, without the call's signal.
    expect(harness.opened[0]?.request.cwd).toBe('/work/proj')
    expect('signal' in (harness.opened[0]?.request ?? {})).toBe(false)
  })

  it('keeps a start alive past the first write, so the second write reports the errors', async () => {
    const lsp = setup(TSFAKE)
    const ctx = lspContext(harness)
    expect(await lsp.diagnosticsFor(ctx, TS, BAD)).toBeUndefined()
    await sleep(300)
    expect(await lsp.diagnosticsFor(ctx, TS, BAD)).toContain('bad word on line 1')
    expect(harness.opened).toHaveLength(1)
  })

  it('does not remember an open refused by a closed invocation as a failed server', async () => {
    const lsp = setup(TSFAKE)
    const ctx = lspContext(harness)
    // Closes the invocation under the pending open, as a call that ends early does.
    const open = ctx.sandbox.openProcess as typeof harness.open
    ctx.sandbox.openProcess = (async () => {
      await sleep(50)
      throw new Error('E_WORKSPACE_CLOSED: workspace invocation is closed')
    }) as never
    expect(await lsp.diagnosticsFor(ctx, TS, BAD)).toBeUndefined()
    await sleep(100)
    ctx.sandbox.openProcess = open as never
    await until(() => lsp.diagnosticsFor(ctx, TS, BAD))
    expect(harness.opened).toHaveLength(1)
  })

  it('gives a server that must write a cache a workspace cache, a hardened env and an ignoring directory', async () => {
    const lsp = setup({ gopls: ['--needs-writable-cache'] })
    const ctx = lspContext(harness)
    expect(await lsp.diagnosticsFor(ctx, '/work/proj/a.go', BAD)).toBeUndefined()
    await sleep(300)
    expect(await lsp.diagnosticsFor(ctx, '/work/proj/a.go', BAD)).toContain('bad word on line 1')
    const env = harness.opened[0]?.request.env ?? {}
    expect(env).toMatchObject({
      GOENV: 'off',
      GOTOOLCHAIN: 'local',
      GOPROXY: 'off',
      GOFLAGS: '-mod=readonly',
      CGO_ENABLED: '0',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    })
    // HOME is never moved into the repository, where a clone could have planted config in it.
    expect(env.HOME?.startsWith('/work/proj')).not.toBe(true)
    expect(new TextDecoder().decode(await ctx.fs.read('/work/proj/.agnes-lsp/.gitignore'))).toBe('*\n')
  })

  it.each(['/.agnes-lsp', '/.agnes-lsp/gopls', '/.agnes-lsp/go-build'])(
    'does not start a server that needs a cache directory when %s is a symlink',
    async (link) => {
      const lsp = setup({ gopls: [] })
      const ctx = lspContext(harness)
      ctx.fs.stat = (async (p: string) =>
        p.endsWith(link)
          ? { kind: 'symlink', size: 0, mtimeMs: 0 }
          : Promise.reject(new Error('ENOENT'))) as never
      expect(await lsp.diagnosticsFor(ctx, '/work/proj/a.go', BAD)).toBeUndefined()
      await sleep(100)
      expect(harness.opened).toHaveLength(0)
    },
  )

  it('waits for the version it sent, not for a stale publish', async () => {
    const lsp = setup({ 'typescript-language-server': ['--stale'] })
    const ctx = lspContext(harness)
    await until(() => lsp.diagnosticsFor(ctx, TS, BAD))
    const text = await lsp.diagnosticsFor(ctx, TS, 'x BAD\n')
    expect(text).toContain('bad word on line 1')
    expect(text).not.toContain('stale')
  })

  it('attaches nothing when the server is slower than the wait', async () => {
    const lsp = setup({ 'typescript-language-server': ['--delay=600'] }, { autoWaitMs: 100 })
    const ctx = lspContext(harness)
    await lsp.diagnosticsFor(ctx, TS, BAD)
    await vi.waitFor(() => expect(harness.opened).toHaveLength(1))
    await sleep(300)
    const started = Date.now()
    expect(await lsp.diagnosticsFor(ctx, TS, 'BAD\n')).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('uses pull diagnostics when the server offers them', async () => {
    const lsp = setup({ 'typescript-language-server': ['--pull'] })
    const ctx = lspContext(harness)
    await until(() => lsp.diagnosticsFor(ctx, TS, BAD))
    expect(await lsp.diagnosticsFor(ctx, TS, 'a\nBAD\n')).toContain('2:1 bad word on line 2')
  })

  it('does nothing while inactive, without a local sandbox, or in a subagent session', async () => {
    const inactive = new LspSessions()
    harness = sandboxHarness(TSFAKE)
    expect(await inactive.diagnosticsFor(lspContext(harness), TS, BAD)).toBeUndefined()

    const lsp = setup(TSFAKE)
    expect(await lsp.diagnosticsFor(lspContext(undefined), TS, BAD)).toBeUndefined()

    const child = lspContext(harness)
    Object.assign(child.session, { generationDepth: 1 })
    expect(await lsp.diagnosticsFor(child, TS, BAD)).toBeUndefined()
    await sleep(100)
    expect(harness.opened).toHaveLength(0)

    const optedIn = setup(TSFAKE, { autoAttachInChildren: true })
    const again = lspContext(harness)
    Object.assign(again.session, { generationDepth: 1 })
    await until(() => optedIn.diagnosticsFor(again, TS, BAD))
  })

  it('starts servers with an allowlisted environment and a bare PATH command, never a workspace binary', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-secret'
    try {
      const lsp = setup(TSFAKE)
      const ctx = lspContext(harness, { 'node_modules/.bin/typescript-language-server': '#!/bin/sh' })
      await until(() => lsp.diagnosticsFor(ctx, TS, BAD))
      const request = harness.opened[0]?.request
      expect(request?.argv.map((a) => basename(a))).toEqual(['typescript-language-server', '--stdio'])
      expect(Object.keys(request?.env ?? {})).not.toContain('ANTHROPIC_API_KEY')
      expect(Object.keys(request?.env ?? {})).toContain('PATH')
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
  })
})

describe('through the write and edit tools', () => {
  const texts = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text)

  it('adds the errors to the result once the server is warm, and none when the text is clean', async () => {
    const lsp = setup(TSFAKE)
    const write = createWriteTool(undefined, lsp)
    const edit = createEditTool(undefined, lsp)
    const ctx = lspContext(harness)
    const first = await write.execute({ path: 'a.ts', content: 'let a = BAD\n' }, ctx)
    expect(texts(first)).toEqual(['created a.ts (12 chars)'])
    await vi.waitFor(() => expect(harness.opened).toHaveLength(1))
    await sleep(300)
    const again = await write.execute({ path: 'a.ts', content: 'let a = BAD\nlet b = BAD\n' }, ctx)
    expect(texts(again)).toEqual([
      'overwrote a.ts (24 chars)',
      'LSP found 2 errors in a.ts:\n1:9 bad word on line 1 (fake F1)\n2:9 bad word on line 2 (fake F1)',
    ])
    const fixed = await edit.execute(
      { path: 'a.ts', edits: [{ oldText: 'BAD\nlet b = BAD', newText: '1\nlet b = 2' }] },
      ctx,
    )
    expect(texts(fixed)).toEqual(['applied 1 edit(s) to a.ts (+0 lines)'])
  })

  it('leaves the result alone when the server is too slow', async () => {
    const lsp = setup({ 'typescript-language-server': ['--delay=600'] }, { autoWaitMs: 100 })
    const write = createWriteTool(undefined, lsp)
    const ctx = lspContext(harness)
    await write.execute({ path: 'a.ts', content: 'BAD\n' }, ctx)
    await vi.waitFor(() => expect(harness.opened).toHaveLength(1))
    await sleep(300)
    expect(texts(await write.execute({ path: 'a.ts', content: 'BAD BAD\n' }, ctx))).toEqual([
      'overwrote a.ts (8 chars)',
    ])
  })
})

describe('starting without running workspace code', () => {
  const echoed = async (command: string, file: string, config = {}, withTypescript = true) => {
    const lsp = setup({ [command]: ['--echo-init'] }, config, withTypescript)
    const [report] = await lsp.check(lspContext(harness, { [file]: 'x\n' }), [file])
    return { report, request: harness.opened[0]?.request }
  }
  const sent = (report?: { diags?: readonly { message: string }[] }) =>
    JSON.parse(report?.diags?.[0]?.message ?? 'null')

  it('launches by absolute real path with only absolute PATH entries, and pins tsserver with no plugins or ATA', async () => {
    const { report, request } = await echoed('typescript-language-server', 'a.ts')
    expect(request?.argv).toEqual([
      realpathSync(join(install.searchPath, 'typescript-language-server')),
      '--stdio',
    ])
    expect(request?.env?.PATH).toBe(install.searchPath)
    expect(sent(report)).toEqual({
      tsserver: { path: realpathSync(install.tsserver) },
      plugins: [],
      disableAutomaticTypingAcquisition: true,
    })
  })

  it('ignores empty and relative PATH entries', async () => {
    const lsp = setup({ gopls: [] })
    lsp.configure({ searchPath: `:bin:./bin:${install.searchPath}` })
    const [report] = await lsp.check(lspContext(harness, { 'm.go': 'x' }), ['m.go'])
    expect(report?.diags).toEqual([])
    expect(harness.opened[0]?.request.env?.PATH).toBe(install.searchPath)
  })

  it('drops PATH entries inside the workspace from both resolution and the server environment', async () => {
    const lsp = setup({ gopls: [] })
    const system = fakeInstall(['gopls'])
    lsp.configure({ searchPath: `${install.searchPath}:${system.searchPath}` })
    const ctx = lspContext(harness, { [`${install.root}/m.go`]: 'x' })
    Object.assign(ctx.session, { workspaceRoot: install.root })
    const [report] = await lsp.check(ctx, [`${install.root}/m.go`])
    expect(report?.diags).toEqual([])
    expect(harness.opened[0]?.request.argv[0]).toBe(join(system.searchPath, 'gopls'))
    expect(harness.opened[0]?.request.env?.PATH).toBe(system.searchPath)
  })

  it('does not start TypeScript when no tsserver sits beside the PATH server', async () => {
    const { report } = await echoed('typescript-language-server', 'a.ts', {}, false)
    expect(report?.note).toMatch(/no non-workspace tsserver found/)
    expect(harness.opened).toHaveLength(0)
  })

  it('starts rust-analyzer only in a trusted workspace, with nothing built or wrapped', async () => {
    const untrusted = await echoed('rust-analyzer', 'a.rs')
    expect(untrusted.report?.note).toMatch(/Rust analysis needs a trusted workspace \(it runs Cargo\)/)
    expect(harness.opened).toHaveLength(0)
    const { report, request } = await echoed('rust-analyzer', 'a.rs', { trusted: true })
    expect(sent(report)).toEqual({
      cargo: { buildScripts: { enable: false } },
      procMacro: { enable: false },
      checkOnSave: false,
    })
    expect(request?.env).toMatchObject({ RUSTC_WRAPPER: '' })
  })

  it('keeps gopls off the network and read-only on go.mod, whatever the worker environment says', async () => {
    process.env.GOFLAGS = '-mod=mod'
    try {
      const { request } = await echoed('gopls', 'a.go')
      expect(request?.env).toMatchObject({ GOTOOLCHAIN: 'local', GOPROXY: 'off', GOFLAGS: '-mod=readonly' })
    } finally {
      delete process.env.GOFLAGS
    }
  })
})

describe('lifecycle', () => {
  it('does not retry a server that exited for the failure window, then tries again', async () => {
    const lsp = setup({ 'typescript-language-server': ['--crash-after-init'] }, { failMs: 400 })
    const ctx = lspContext(harness)
    await lsp.diagnosticsFor(ctx, TS, BAD)
    await vi.waitFor(() => expect(harness.opened[0]?.exited).toBe(true), { timeout: 3000 })
    await sleep(50)
    await lsp.diagnosticsFor(ctx, TS, BAD)
    await lsp.diagnosticsFor(ctx, TS, BAD)
    expect(harness.opened).toHaveLength(1)
    await sleep(450)
    await lsp.diagnosticsFor(ctx, TS, BAD)
    await vi.waitFor(() => expect(harness.opened).toHaveLength(2), { timeout: 3000 })
  })

  it('marks a server that never initializes as unavailable, and says why through the tool', async () => {
    const lsp = setup({ 'typescript-language-server': ['--no-init'] }, { initMs: 150, toolStartMs: 2000 })
    const files = { 'a.ts': BAD }
    const ctx = lspContext(harness, files)
    const [report] = await lsp.check(ctx, ['a.ts'])
    expect(report?.diags).toBeUndefined()
    expect(report?.note).toMatch(/could not start typescript-language-server .*initialize timed out/)
    const [second] = await lsp.check(ctx, ['a.ts'])
    expect(second?.note).toMatch(/could not start/)
    expect(harness.opened).toHaveLength(1)
  })

  it('falls back to the next command when the first is not installed', async () => {
    const lsp = setup({ 'basedpyright-langserver': ok })
    const [report] = await lsp.check(lspContext(harness, { 'm.py': 'x = BAD\n' }), ['m.py'])
    expect(report?.diags).toHaveLength(1)
    expect(harness.opened.map((o) => basename(o.request.argv[0] as string))).toEqual([
      'basedpyright-langserver',
    ])
  })

  it('reports a missing language server with an install hint', async () => {
    const lsp = setup({})
    const [report] = await lsp.check(lspContext(harness, { 'm.go': 'package m\n' }), ['m.go'])
    expect(report?.note).toMatch(/could not start gopls \(gopls not found on PATH\).*PATH/)
  })

  it('closes a server after it has been idle', async () => {
    const lsp = setup(TSFAKE, { idleMs: 200 })
    const ctx = lspContext(harness)
    await until(() => lsp.diagnosticsFor(ctx, TS, BAD))
    expect(harness.opened[0]?.exited).toBe(false)
    await vi.waitFor(() => expect(harness.opened[0]?.exited).toBe(true), { timeout: 3000 })
  })

  it('closes a session’s servers with the session, and only that session’s', async () => {
    const lsp = setup(TSFAKE)
    const a = lspContext(harness, {}, 'closing-a')
    const b = lspContext(harness, {}, 'closing-b')
    await until(() => lsp.diagnosticsFor(a, TS, BAD))
    await until(() => lsp.diagnosticsFor(b, TS, BAD))
    await lsp.closeSession('closing-a', 'main')
    expect(harness.opened.map((o) => o.exited)).toEqual([true, false])
    await lsp.dispose()
    expect(harness.opened.every((o) => o.exited)).toBe(true)
  })

  it('keeps three servers per session and evicts the least recently used', async () => {
    const lsp = setup(
      { ...TSFAKE, 'pyright-langserver': ok, gopls: ok, 'rust-analyzer': ok },
      { trusted: true },
    )
    const ctx = lspContext(harness, { 'a.py': 'x', 'a.go': 'x', 'a.rs': 'x' })
    for (const file of ['a.ts', 'a.py', 'a.go'])
      await until(() => lsp.diagnosticsFor(ctx, `/work/proj/${file}`, BAD))
    await lsp.diagnosticsFor(ctx, '/work/proj/a.rs', BAD)
    await vi.waitFor(() => {
      expect(
        harness.opened.filter((o) => !o.exited).map((o) => basename(o.request.argv[0] as string)),
      ).toEqual(['pyright-langserver', 'gopls', 'rust-analyzer'])
    })
  })

  it('caps the worker at four servers across sessions, evicting the idlest idle one', async () => {
    const lsp = setup(TSFAKE, { maxServers: 2 })
    const [a, b, c] = ['cap-a', 'cap-b', 'cap-c'].map((key) => lspContext(harness, {}, key))
    await until(() => lsp.diagnosticsFor(a!, TS, BAD))
    await until(() => lsp.diagnosticsFor(b!, TS, BAD))
    await lsp.diagnosticsFor(c!, TS, BAD)
    await vi.waitFor(() => {
      expect(harness.opened.map((o) => o.exited)).toEqual([true, false, false])
    })
  })

  it('refuses a new server when every one at the cap is busy', async () => {
    const lsp = setup({ 'typescript-language-server': ['--delay=800'] }, { maxServers: 1 })
    const a = lspContext(harness, {}, 'busy-a')
    await lsp.diagnosticsFor(a, TS, BAD)
    await vi.waitFor(() => expect(harness.opened).toHaveLength(1))
    await sleep(400)
    const busy = lsp.diagnosticsFor(a, TS, 'BAD\n')
    await sleep(50)
    const [report] = await lsp.check(lspContext(harness, { 'a.ts': BAD }, 'busy-b'), ['a.ts'])
    expect(report?.note).toMatch(/too many language servers/)
    expect(harness.opened).toHaveLength(1)
    await busy
  })
})

describe('lsp_diagnostics path', () => {
  it('checks several files, reads them through the context, and explains what it cannot check', async () => {
    const lsp = setup({ ...TSFAKE, 'pyright-langserver': ok })
    const ctx = lspContext(harness, { 'a.ts': BAD, 'ok.ts': 'fine\n', 'm.py': 'BAD\nBAD\n', 'n.txt': 'BAD' })
    const reports = await lsp.check(ctx, ['a.ts', 'ok.ts', 'm.py', 'n.txt', 'missing.ts'])
    expect(reports.map((r) => [r.path, r.diags?.length, r.note?.slice(0, 24)])).toEqual([
      ['a.ts', 1, undefined],
      ['ok.ts', 0, undefined],
      ['m.py', 2, undefined],
      ['n.txt', undefined, 'no language server is bu'],
      ['missing.ts', undefined, 'cannot read the file: EN'],
    ])
  })

  it('is available to a subagent session and says plainly when the sandbox is remote', async () => {
    const lsp = setup(TSFAKE)
    const child = lspContext(harness, { 'a.ts': BAD })
    Object.assign(child.session, { generationDepth: 2 })
    expect((await lsp.check(child, ['a.ts']))[0]?.diags).toHaveLength(1)
    const [remote] = await lsp.check(lspContext(undefined, { 'a.ts': BAD }), ['a.ts'])
    expect(remote?.note).toMatch(/need a local sandbox/)
  })
})
