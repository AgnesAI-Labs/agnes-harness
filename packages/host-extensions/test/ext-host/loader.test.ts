import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ToolRegistry } from '@agnes/core'
import { HOOK_EVENTS } from '@agnes/extension-api'
import { defineTool } from '@agnes/plugin-runtime'
import { inspectJsonData } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { afterEach, expect, it } from 'vitest'
import { buildExtensionApi } from '../../src/ext-host/api.js'
import { loadError } from '../../src/ext-host/diagnostics.js'
import { createExtHost } from '../../src/ext-host/host.js'
import { createLoader, runtimeForm } from '../../src/ext-host/loader.js'

const roots: string[] = []
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-loader-'))
  roots.push(root)
  return {
    root,
    loader: createLoader({ cacheDir: join(root, 'cache'), hostRoot: root, agnesVersion: '0.0.0' }),
    write(name: string, source: string) {
      const path = join(root, name)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, source)
      return path
    },
  }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('identifies the actual source runtime without a fake SEA flag', () => {
  expect(runtimeForm()).toBe('source')
})

it('requires compatible ordinary plugin apiRange before evaluating any source', async () => {
  const f = setup()
  const marker = join(f.root, 'evaluated')
  const entry = f.write(
    'index.ts',
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'yes'); export const main = () => {}`,
  )
  for (const [apiRange, code] of [
    [undefined, 'E_PROVIDER_INVALID'],
    ['^99.0.0', 'E_PROVIDER_INCOMPATIBLE'],
  ] as const) {
    f.write(
      'package.json',
      JSON.stringify({ name: '@test/provider', agnes: { plugins: [{ export: 'main', apiRange }] } }),
    )
    await expect(f.loader.import(entry)).rejects.toMatchObject({
      code,
      kind: 'plugin',
      operation: 'admit',
      retryable: false,
    })
    expect(readdirSync(f.root)).not.toContain('evaluated')
  }
  f.write(
    'package.json',
    JSON.stringify({ name: '@test/provider', agnes: { plugins: [{ export: 'main', apiRange: '^1.4.0' }] } }),
  )
  expect(await f.loader.import(entry)).toHaveProperty('main')
  expect(readFileSync(marker, 'utf8')).toBe('yes')
})

it('shares all three real host modules even when the extension carries decoy copies', async () => {
  const f = setup()
  for (const name of ['@agnes/extension-api', '@agnes/protocol', '@sinclair/typebox']) {
    f.write(`node_modules/${name}/package.json`, JSON.stringify({ name, main: './index.js' }))
    f.write(`node_modules/${name}/index.js`, 'throw new Error("extension copy executed")')
  }
  const entry = f.write(
    'index.ts',
    `
    import { HOOK_EVENTS } from '@agnes/extension-api'
    import { inspectJsonData } from '@agnes/protocol'
    import { Type } from '@sinclair/typebox'
    import { Value } from '@sinclair/typebox/value'
    export const shared = { HOOK_EVENTS, inspectJsonData, Type, Value }
    export default () => undefined
  `,
  )
  const mod = await f.loader.import(entry)
  expect(mod.shared).toEqual({ HOOK_EVENTS, inspectJsonData, Type, Value })
  const shared = mod.shared as Record<string, unknown>
  expect(shared.HOOK_EVENTS).toBe(HOOK_EVENTS)
  expect(shared.inspectJsonData).toBe(inspectJsonData)
  expect(shared.Type).toBe(Type)
  expect(shared.Value).toBe(Value)
  expect(typeof mod.default).toBe('function')
})

it.each(['ts', 'mjs', 'js'])(
  're-evaluates a %s entry and observes edits with the versioned cache path',
  async (ext) => {
    const f = setup()
    f.write('package.json', '{"type":"module"}')
    const entry = f.write(
      `index.${ext}`,
      'export const fresh = {}; export const value = 1; export default () => {}',
    )
    const first = await f.loader.import(entry)
    const second = await f.loader.import(entry)
    expect(first.fresh).not.toBe(second.fresh)
    f.write(`index.${ext}`, 'export const fresh = {}; export const value = 2; export default () => {}')
    expect((await f.loader.import(entry)).value).toBe(2)
    expect(readdirSync(join(f.root, 'cache', 'jiti', '0.0.0')).length).toBeGreaterThan(0)
  },
)

it('reloads a nested TS dependency and keeps its imports on host namespaces', async () => {
  const f = setup()
  const source = (n: number) =>
    `import { Type } from '@sinclair/typebox'; export const value: number = ${n}; export { Type }`
  f.write('child.ts', source(1))
  const entry = f.write('index.ts', 'export { value, Type } from "./child.ts"; export default () => {}')
  expect((await f.loader.import(entry)).value).toBe(1)
  f.write('child.ts', source(2))
  const second = await f.loader.import(entry)
  expect(second.value).toBe(2)
  expect(second.Type).toBe(Type)
})

it('loads the real author example module through jiti', async () => {
  const f = setup()
  const mod = await f.loader.import(
    fileURLToPath(new URL('../../../extension-api/examples/minimal/index.ts', import.meta.url)),
  )
  expect(typeof mod.default).toBe('function')
})

it.each(['mjs', 'js', 'cjs'])(
  'reloads a nested %s dependency instead of retaining the native cache',
  async (ext) => {
    const f = setup()
    f.write('package.json', '{"type":"module"}')
    const source = (value: number) =>
      ext === 'cjs'
        ? `const { Type } = require('@sinclair/typebox'); module.exports = { value: ${value}, Type }`
        : `import { Type } from '@sinclair/typebox'; export const value = ${value}; export { Type }`
    f.write(`child.${ext}`, source(1))
    const entry = f.write(
      'index.ts',
      ext === 'cjs'
        ? `import child from './child.${ext}'; export const value = child.value; export const Type = child.Type`
        : `export { value, Type } from './child.${ext}'`,
    )
    expect((await f.loader.import(entry)).value).toBe(1)
    f.write(`child.${ext}`, source(2))
    const result = await f.loader.import(entry)
    expect(result.value).toBe(2)
    expect(result.Type).toBe(Type)
  },
)

it.each(['config.json', '中文 空格/config.json'])(
  'reloads JSON dependency %s along with its code',
  async (name) => {
    const f = setup()
    f.write(name, '{"value":1}')
    const entry = f.write(
      'index.ts',
      `import config from ${JSON.stringify(`./${name}`)}; export const value = config.value`,
    )
    expect((await f.loader.import(entry)).value).toBe(1)
    f.write(name, '{"value":2}')
    expect((await f.loader.import(entry)).value).toBe(2)
  },
)

it('reloads a plain nested ESM module whose native import would succeed without fallback', async () => {
  const f = setup()
  f.write('child.mjs', 'export const value = 1')
  const entry = f.write('index.ts', 'export { value } from "./child.mjs"')
  expect((await f.loader.import(entry)).value).toBe(1)
  f.write('child.mjs', 'export const value = 2')
  expect((await f.loader.import(entry)).value).toBe(2)
})

it('connects real jiti modules to the existing host and kernel tool registry, including cleanup', async () => {
  const f = setup()
  const tools = new ToolRegistry()
  const ext = await createExtHost({
    packages: new Map([
      ['fixture/pkg', fileURLToPath(new URL('../../../host/test/fixtures/pkg-exts', import.meta.url))],
    ]),
    tools,
    importModule: (entry) => f.loader.import(entry),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  })
  try {
    expect(ext.status().find((s) => s.id === 'fixture/ok')?.loaded).toBe(true)
    expect(tools.resolve('fx_one')?.source).toEqual({ source: 'fixture/ok', trust: 'builtin' })
    expect(tools.size).toBe(1)
    expect(tools.resolve('tx_one')).toBeUndefined()
    expect(ext.status().find((s) => s.id === 'fixture/throws')?.loaded).toBe(false)
  } finally {
    await ext.disposeAll()
  }
  expect(tools.size).toBe(0)
})

it('does not let the legacy loader mint classified-tool provenance or a Host domain', () => {
  const tools = new ToolRegistry()
  const api = buildExtensionApi(
    {
      id: 'agnes/computer-use',
      version: '1.0.0',
      apiRange: '*',
      entry: './index.js',
      tools: { prefix: '', names: null },
    },
    tools,
    (_name, dispose) => dispose,
    () => true,
  )
  expect(() =>
    api.registerTool({
      name: 'computer',
      description: 'classified legacy tool',
      parameters: Type.Object({}),
      meta: {
        isReadOnly: false,
        isDestructive: true,
        isConcurrencySafe: false,
        isOpenWorld: true,
        requiresApproval: 'always',
        replay: 'never',
        costHint: undefined,
        deferLoading: undefined,
      },
      policyVersion: 'v1',
      classify: () => ({
        isReadOnly: false,
        isDestructive: true,
        replay: 'never',
        requiresApproval: 'always',
        approvalScopes: [],
      }),
      execute: async () => ({ content: [{ type: 'text', text: 'never runs' }] }),
    }),
  ).toThrow(/Host-attested package identity and version/)
  expect(tools.size).toBe(0)
})

it('supports top-level await and dynamic TS imports without sharing successive module state', async () => {
  const f = setup()
  f.write('child.ts', 'export const state = { value: 1 }')
  const entry = f.write(
    'index.ts',
    'await Promise.resolve(); export const state = (await import("./child.ts")).state',
  )
  const [first, second] = await Promise.all([f.loader.import(entry), f.loader.import(entry)])
  expect(first.state).toEqual({ value: 1 })
  expect(second.state).toEqual({ value: 1 })
  expect(first.state).not.toBe(second.state)
})

it('does not include thrown extension text in a load error and can retry a repaired entry', async () => {
  const f = setup()
  const entry = f.write('index.ts', 'throw new Error("credential-test-marker"); export default () => {}')
  await expect(f.loader.import(entry)).rejects.toThrow('E_EXT_LOAD: extension module evaluation failed')
  try {
    await f.loader.import(entry)
  } catch (error) {
    expect(String(error)).not.toContain('credential-test-marker')
  }
  f.write('index.ts', 'export default () => {}')
  expect(typeof (await f.loader.import(entry)).default).toBe('function')
})

it('refuses a cache version that could escape its version directory', () => {
  const f = setup()
  expect(() => createLoader({ cacheDir: f.root, hostRoot: f.root, agnesVersion: '../elsewhere' })).toThrow(
    /E_EXT_LOAD/,
  )
})

it('accepts prerelease and build identifiers in the cache version', async () => {
  const f = setup()
  const loader = createLoader({
    cacheDir: join(f.root, 'cache'),
    hostRoot: f.root,
    agnesVersion: '0.1.0-dev+abc',
  })
  const entry = f.write('index.ts', 'export default () => {}')
  expect(typeof (await loader.import(entry)).default).toBe('function')
  expect(readdirSync(join(f.root, 'cache', 'jiti', '0.1.0-dev+abc')).length).toBeGreaterThan(0)
})

it('blocks late registration from a real native extension module', async () => {
  const f = setup()
  f.write('package.json', JSON.stringify({ agnes: { extensions: ['extension'] } }))
  f.write(
    'extension/agnes.extension.json',
    JSON.stringify({
      id: 'fixture/phase',
      version: '1.0.0',
      apiRange: '^1.0',
      entry: './index.mjs',
      capabilities: { tools: { prefix: 'late_' } },
    }),
  )
  const marker = join(f.root, 'result.txt')
  f.write(
    'extension/index.mjs',
    `
    import { writeFileSync } from 'node:fs'
    export default (api) => {
      queueMicrotask(() => {
        try {
          api.registerTool({
            name: 'late_tool', description: 'late registration',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            meta: { isReadOnly: true, isDestructive: false, isConcurrencySafe: true,
              isOpenWorld: false, replay: 'safe', costHint: undefined, deferLoading: false, requiresApproval: 'never' },
            execute: async () => ({ content: [] }),
          })
          writeFileSync(${JSON.stringify(marker)}, 'REGISTERED')
        } catch (error) { writeFileSync(${JSON.stringify(marker)}, String(error)) }
      })
    }
  `,
  )
  const tools = new ToolRegistry()
  const ext = await createExtHost({
    packages: new Map([['fixture/pkg', f.root]]),
    tools,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  })
  try {
    expect(ext.status()[0]?.loaded).toBe(true)
    expect(readFileSync(marker, 'utf8')).toContain('E_CAPABILITY_UNDECLARED')
    expect(readFileSync(marker, 'utf8')).toContain('outside factory')
    expect(tools.size).toBe(0)
  } finally {
    await ext.disposeAll()
  }
})

it.each(['ts', 'js'])(
  'loads an external %s SDK graph without node_modules and resolves package-owned dependencies',
  async (ext) => {
    const f = setup()
    f.write(
      'package.json',
      JSON.stringify({
        type: 'module',
        agnes: {
          hostProvidedExternals: {
            '@agnes/plugin-runtime': '0.0.0',
            '@agnes/extension-api': '^1.4.0',
            '@sinclair/typebox': '~0.34.0',
          },
        },
      }),
    )
    f.write(
      'node_modules/own-dependency/package.json',
      JSON.stringify({ name: 'own-dependency', main: './index.js' }),
    )
    f.write('node_modules/own-dependency/index.js', 'exports.value = 42')
    const entry = f.write(
      `index.${ext}`,
      `
    import { defineTool } from '@agnes/plugin-runtime'
    import { Type } from '@sinclair/typebox'
    import { value } from 'own-dependency'
    export { defineTool, Type, value }
  `,
    )
    expect(await f.loader.import(entry)).toMatchObject({ defineTool, Type, value: 42 })
    f.write(
      'package.json',
      JSON.stringify({ agnes: { hostProvidedExternals: { '@agnes/extension-api': '^99.0.0' } } }),
    )
    await expect(f.loader.import(entry)).rejects.toThrow(/@agnes\/extension-api.*incompatible.*upgrade AGH/)
  },
)

it('names missing modules and fixes while withholding arbitrary evaluation errors', async () => {
  const f = setup()
  const entry = f.write('index.ts', "import 'missing-dependency'; export default () => {}")
  await f.loader.import(entry).catch((error) => {
    expect(loadError(error, 'import').message).toContain('missing-dependency')
    expect(loadError(error, 'import').message).toContain('bundle/install')
  })
  await expect(f.loader.import(entry)).rejects.toThrow(
    /Missing plugin module "missing-dependency".*bundle\/install/,
  )
  f.write(
    'package.json',
    JSON.stringify({ agnes: { hostProvidedExternals: { '@agnes/plugin-runtime/host': '*' } } }),
  )
  await expect(f.loader.import(entry)).rejects.toThrow(/Host does not provide module.*plugin-runtime\/host/)
})
