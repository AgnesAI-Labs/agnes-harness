import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundledExtensionManifest, type Disposer } from '@agnes/extension-api'
import type { ExtensionAPI } from '@agnes/extension-api/host'
import { extensionFactoryOf } from '@agnes/plugin-runtime/bundled'
import { describe, expect, it } from 'vitest'
import type { Diagnostic } from '../src/client.js'
import { serverEnv } from '../src/env.js'
import { formatAuto, formatTool } from '../src/format.js'
import { encodeFrame, FrameDecoder } from '../src/framing.js'
import factory, { createLspExtension, LspSessions } from '../src/index.js'
import { findTsserver, launchArgv, resolveBinary, safeEntries } from '../src/resolve.js'
import { findRoot, serverFor } from '../src/servers.js'
import { createLspDiagnosticsTool } from '../src/tool.js'
import { fakeInstall } from './harness.js'

describe('framing', () => {
  const messages = [{ a: 1 }, { text: '你好，世界 🌍' }]
  const wire = messages.map(encodeFrame).join('')

  it('counts the length in bytes, not characters', () => {
    const frame = encodeFrame({ t: '你好' })
    const body = JSON.stringify({ t: '你好' })
    expect(frame).toBe(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    expect(Buffer.byteLength(body)).toBeGreaterThan(body.length)
  })

  it('decodes frames glued together in one chunk', () => {
    expect(new FrameDecoder().push(wire)).toEqual(messages)
  })

  it('decodes a frame split at every possible position, even in the middle of a message', () => {
    // The sandbox decodes output with a StringDecoder, so a chunk never ends inside a character.
    const chars = [...wire]
    for (let cut = 1; cut < chars.length; cut++) {
      const decoder = new FrameDecoder()
      const got = [...decoder.push(chars.slice(0, cut).join('')), ...decoder.push(chars.slice(cut).join(''))]
      expect(got).toEqual(messages)
    }
  })

  it('skips stray output between frames and refuses an absurd length', () => {
    expect(new FrameDecoder().push(`log line\r\n\r\n${wire}`)).toEqual(messages)
    expect(() => new FrameDecoder().push('Content-Length: 999999999\r\n\r\n')).toThrow(/too large/)
  })
})

describe('servers', () => {
  // findRoot joins markers with the platform separator; compare in that spelling.
  const present = (files: string[]) => async (p: string) => files.some((file) => join(file) === p)

  it('picks the server by extension and the root by the nearest marker', async () => {
    expect(serverFor('/w/a.tsx')?.languageId).toBe('typescriptreact')
    expect(serverFor('/w/a.py')?.def.id).toBe('python')
    expect(serverFor('/w/a.txt')).toBeUndefined()
    const ts = serverFor('/w/a.ts')!.def
    const exists = present(['/w/package.json', '/w/pkg/tsconfig.json'])
    expect(await findRoot(exists, '/w/pkg/src/a.ts', '/w', ts)).toBe('/w/pkg')
    expect(await findRoot(exists, '/w/other/a.ts', '/w', ts)).toBe('/w')
    // No marker anywhere: the workspace root. A file outside it is rooted at its own directory.
    expect(await findRoot(present([]), '/w/x/a.ts', '/w', ts)).toBe('/w')
    expect(await findRoot(present([]), '/extra/a.ts', '/w', ts)).toBe('/extra')
  })

  it('does not start the TypeScript server under a Deno project', async () => {
    const ts = serverFor('/w/a.ts')!.def
    expect(await findRoot(present(['/w/deno.json', '/w/package.json']), '/w/a.ts', '/w', ts)).toBeUndefined()
  })

  it('passes only allowlisted environment variables', () => {
    const env = serverEnv({
      PATH: '/bin',
      HOME: '/h',
      LC_ALL: 'C',
      GOPATH: '/g',
      ANTHROPIC_API_KEY: 'secret',
      OPENAI_API_KEY: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
    })
    expect(Object.keys(env).sort()).toEqual(['GOPATH', 'HOME', 'LC_ALL', 'PATH'])
  })
})

describe('binary resolution', () => {
  it('filters PATH to absolute, unique entries outside the workspace, and takes the first match', () => {
    const a = fakeInstall(['gopls'])
    const b = fakeInstall(['gopls'])
    const path = ['', 'rel', './x', a.searchPath, a.searchPath, b.searchPath].join(delimiter)
    expect(safeEntries(path, ['/work/proj'])).toEqual([a.searchPath, b.searchPath])
    // An entry inside the workspace root (or the cwd) is gone, for resolving and for the env alike.
    expect(safeEntries(path, [a.root])).toEqual([b.searchPath])
    expect(resolveBinary('gopls', [a.searchPath, b.searchPath], ['/work/proj'])).toEqual({
      path: join(a.searchPath, 'gopls'),
    })
    // A match that resolves inside the workspace (a symlink out of a safe directory) is refused.
    expect(resolveBinary('gopls', [a.searchPath], [a.root])).toMatchObject({
      refused: expect.stringContaining('inside the workspace'),
    })
    expect(resolveBinary('missing', [a.searchPath], [])).toBeUndefined()
  })

  it('runs a shebang script through an interpreter resolved from the safe PATH', () => {
    const tools = fakeInstall(['node', 'plain'])
    const workspace = fakeInstall(['node'])
    const script = join(tools.root, 'cli.mjs')
    writeFileSync(script, '#!/usr/bin/env node\nconsole.log(1)\n')
    const node = join(tools.searchPath, 'node')
    expect(launchArgv(script, ['--stdio'], [tools.searchPath], [])).toEqual({
      argv: [node, script, '--stdio'],
    })
    // `env -S node --flag`: flags stay between the interpreter and the script.
    writeFileSync(script, '#!/usr/bin/env -S node --no-warnings\n')
    expect(launchArgv(script, [], [tools.searchPath], [])).toEqual({ argv: [node, '--no-warnings', script] })
    // A binary (no shebang) runs as is.
    expect(launchArgv(join(tools.searchPath, 'plain'), ['x'], [], [])).toEqual({
      argv: [join(tools.searchPath, 'plain'), 'x'],
    })
    // An interpreter that is only in the workspace is not used: the server is unavailable.
    writeFileSync(script, '#!/usr/bin/env node\n')
    expect(launchArgv(script, [], [workspace.searchPath], [workspace.root])).toMatchObject({
      unavailable: expect.stringContaining('interpreter'),
    })
    expect(launchArgv(script, [], [], [])).toMatchObject({
      unavailable: expect.stringContaining('interpreter'),
    })
    // An absolute interpreter inside the workspace is refused too.
    writeFileSync(script, `#!${join(workspace.searchPath, 'node')}\n`)
    expect(launchArgv(script, [], [], [workspace.root])).toMatchObject({
      unavailable: expect.stringContaining('inside the workspace'),
    })
  })

  it('finds the typescript beside the server, and refuses one inside the workspace', () => {
    const install = fakeInstall(['typescript-language-server'])
    const binary = realpathSync(join(install.searchPath, 'typescript-language-server'))
    expect(findTsserver(binary, '/work/proj')).toBe(install.tsserver)
    expect(findTsserver(binary, install.root)).toBeUndefined()
    expect(
      findTsserver(
        realpathSync(
          join(fakeInstall(['typescript-language-server'], false).searchPath, 'typescript-language-server'),
        ),
        '/w',
      ),
    ).toBeUndefined()
  })
})

describe('format', () => {
  const at = (line: number, message: string, severity = 1, source?: string): Diagnostic => ({
    range: { start: { line, character: 2 }, end: { line, character: 5 } },
    severity,
    message,
    ...(source ? { source, code: 2322 } : {}),
  })

  it('reports only errors, sorted, with source and code, and nothing when there are none', () => {
    expect(formatAuto('a.ts', [at(0, 'only a warning', 2)])).toBeUndefined()
    expect(formatAuto('a.ts', [at(4, 'second\nline', 1, 'ts'), at(1, 'first'), at(2, 'w', 2)])).toBe(
      'LSP found 2 errors in a.ts:\n2:3 first\n5:3 second line (ts 2322)',
    )
  })

  it('caps the count at 20 and the size at 4KB', () => {
    const many = Array.from({ length: 25 }, (_, i) => at(i, `e${i}`))
    expect(formatAuto('a.ts', many)?.split('\n').slice(-2)).toEqual(['20:3 e19', '… 5 more'])
    const long = [at(0, 'x'.repeat(10_000))]
    const text = formatAuto('a.ts', long)!
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096)
    expect(text.endsWith('(truncated)')).toBe(true)
    expect(Buffer.byteLength(formatAuto('a.ts', long, 300)!)).toBeLessThanOrEqual(300)
  })

  it('summarises for the tool, filters by severity, deduplicates and says why a file was not checked', () => {
    const diags = [at(3, 'w', 2), at(1, 'e'), at(1, 'e'), at(0, 'hint', 4)]
    const reports = [
      { path: 'a.ts', diags },
      { path: 'b.go', note: 'gopls is not installed' },
    ]
    expect(formatTool(reports, 'error')).toBe(
      '2 errors, 1 warning in 2 files\na.ts:\n  2:3 error e\nb.go: not checked - gopls is not installed',
    )
    expect(formatTool(reports, 'all')).toContain('4:3 warning w')
    expect(formatTool(reports, 'all')).toContain('1:3 hint hint')
    expect(formatTool([{ path: 'c.ts', diags: [] }], 'warning')).toContain('c.ts: no errors or warnings')
    const big = Array.from({ length: 60 }, (_, i) => at(i, `e${i}`))
    expect(formatTool([{ path: 'a.ts', diags: big }], 'error')).toContain('… 10 more')
  })
})

const manifest = bundledExtensionManifest(
  JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')),
) as {
  id: string
  entry: string
  apiRange: string
  capabilities: {
    tools: { prefix: string; names: string[] }
    hooks: string[]
    network: string[]
    artifacts: boolean
  }
}

describe('lsp manifest', () => {
  it('declares the tool and only the hook and artifacts it uses, with no network', () => {
    expect(manifest.id).toBe('agnes/lsp')
    expect(manifest.capabilities.tools).toEqual({ prefix: '', names: ['lsp_diagnostics'] })
    expect(manifest.capabilities.hooks).toEqual(['shutdown'])
    expect(manifest.capabilities.network).toEqual([])
    expect(manifest.capabilities.artifacts).toBe(true)
  })

  it('registers exactly the declared tool, activates the registry, and disposes both', async () => {
    const lsp = new LspSessions()
    expect(lsp.isActive).toBe(false)
    const registered: string[] = []
    const hooks: string[] = []
    const api = {
      registerTool: (d: { name: string }): Disposer => {
        registered.push(d.name)
        return () => undefined
      },
      registerHook: (event: string): Disposer => {
        hooks.push(event)
        return () => undefined
      },
    } as unknown as ExtensionAPI
    const dispose = (await extensionFactoryOf(createLspExtension(lsp))(api)) as Disposer
    expect(registered).toEqual(manifest.capabilities.tools.names)
    expect(hooks).toEqual(manifest.capabilities.hooks)
    expect(lsp.isActive).toBe(true)
    await dispose()
    expect(lsp.isActive).toBe(false)
    expect(typeof factory.apply).toBe('function')
  })

  it('has a read-only, deferred, approval-free tool definition', () => {
    const tool = createLspDiagnosticsTool(new LspSessions())
    expect(tool.meta).toMatchObject({ isReadOnly: true, deferLoading: 'auto', requiresApproval: 'never' })
  })
})
