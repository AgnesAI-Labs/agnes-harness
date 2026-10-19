import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import type { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { runAuthoringTests } from '../src/packages/authoring-tests.js'

const { build, exec } = vi.hoisted(() => ({ build: vi.fn(), exec: vi.fn() }))
vi.mock('node:module', async (original) => {
  const mod = await original<typeof import('node:module')>()
  return {
    ...mod,
    createRequire: (url: Parameters<typeof createRequire>[0]) => {
      const require = mod.createRequire(url)
      return Object.assign((name: string) => (name === 'esbuild' ? { build } : require(name)), require)
    },
  }
})
vi.mock('../src/packages/authoring-sandbox.js', () => ({
  defaultAuthoringSandboxContext: () => ({}),
  authoringSandbox: async () => ({ sandbox: { exec } }),
}))
const roots: string[] = []
afterEach(() => {
  vi.resetAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it('retains redacted assertion details, package-relative locations and bounded compile failures without starting processes', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'agh-author-output-中文 #%-')))
  roots.push(directory)
  mkdirSync(join(directory, 'test'))
  const files = [
    { path: 'package.json', content: '{"name":"test"}' },
    { path: 'test/fail.test.mjs', content: '' },
  ]
  const privateHome = ['', 'Users', 'synthetic'].join('/')
  const testFile = join(directory, 'test', 'fail.test.mjs')
  build.mockResolvedValue({})
  exec.mockResolvedValue({
    stdout: `not ok 1 - persists data\n  name: AssertionError\n  error: expected 2 entries, got 0\n  location: ${pathToFileURL(testFile).href}:4:1\n  private: ${privateHome}/private/data.json\n  stack: |-\n    TestContext.privateFrame (file://${privateHome}/private/test.mjs:1:1)\n# tests 1\n# fail 1\n# pass 0\n# authoring-exit 1\n${'x'.repeat(20000)}`,
  })
  const result = await runAuthoringTests(directory, files, new AbortController().signal)
  expect(result).toMatchObject({ state: 'failed', count: 1 })
  for (const detail of [
    'AssertionError',
    'expected 2 entries, got 0',
    './test/fail.test.mjs:4:1',
    '[truncated]',
  ])
    expect(result.output).toContain(detail)
  expect(result.output).not.toContain('privateFrame')
  expect(result.output).not.toMatch(/\/Users\/|agh-author-output-/)
  expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(16384)
  build.mockRejectedValue({
    errors: [
      { text: 'Unexpected token', location: { file: testFile, line: 3, column: 2 } },
      {
        text: `Cannot import ${privateHome}/private/module.js`,
        location: { file: `${privateHome}/private/module.js`, line: 1, column: 1 },
      },
    ],
  })
  const compile = await runAuthoringTests(directory, files, new AbortController().signal)
  expect(compile).toMatchObject({ state: 'failed', count: 0 })
  expect(compile.output).toContain('CompileError: Unexpected token (./test/fail.test.mjs:3:2)')
  expect(compile.output).not.toContain(privateHome)
  build.mockResolvedValue({})
  exec.mockRejectedValue(
    Object.assign(new Error('command timed out'), {
      stdout: `not ok 1 - profile panel\n  error: query never completed\n  location: ${pathToFileURL(testFile).href}:4:1\n  private: ${privateHome}/private/data.json\n# tests 1\n# pass 1\n# fail 0\n# authoring-exit 0`,
    }),
  )
  const timedOut = await runAuthoringTests(directory, files, new AbortController().signal)
  expect(timedOut).toMatchObject({ state: 'failed', count: 0 })
  expect(timedOut.output).toContain('query never completed')
  expect(timedOut.output).toContain('./test/fail.test.mjs:4:1')
  expect(timedOut.output).toContain('command timed out')
  expect(timedOut.output).not.toContain(privateHome)
  const ac = new AbortController()
  build.mockImplementation(async () => {
    ac.abort(new Error('stopped'))
    throw ac.signal.reason
  })
  await expect(runAuthoringTests(directory, files, ac.signal)).rejects.toThrow('stopped')
})
