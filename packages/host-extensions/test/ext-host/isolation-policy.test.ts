import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionFactory } from '@agnes/extension-api'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SeamInitContext } from '../../src/assemble/packages.js'
import { createExtensionFactorySelector } from '../../src/ext-host/extension-isolation-selector.js'

let dir: string
const id = 'acme/plugin'
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agnes-isolation-policy-'))
  writeFileSync(join(dir, 'index.js'), 'throw Error("must not import")')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
function select(mode: 'off' | 'preferred' | 'required', supports?: ('in-process' | 'isolated')[]) {
  writeFileSync(
    join(dir, 'agnes.extension.json'),
    JSON.stringify({
      id,
      version: '1.0.0',
      apiRange: '^1.0',
      entry: './index.js',
      capabilities: {},
      ...(supports ? { runtime: { supports } } : {}),
    }),
  )
  const factory: ExtensionFactory = () => {},
    prepare = vi.fn(() => factory),
    setIsolation = vi.fn(),
    audit = vi.fn()
  const selector = createExtensionFactorySelector({
    options: { extensions: { [id]: mode } },
    runtimeDirectory: dir,
    target: 'linux-x64',
    modules: new Map([[id, { id, ecosystem: { [id]: prepare } }]]),
    contextFor: () => ({}) as SeamInitContext,
    managed: { setIsolation, fail: vi.fn() },
    audit,
  })
  return { selector, prepare, setIsolation, audit }
}
it('defaults missing runtime support to in-process, before invoking its registered factory', async () => {
  const x = select('off')
  await expect(x.selector(id, id, dir, dir)).resolves.toBeTypeOf('function')
  expect(x.prepare).toHaveBeenCalledOnce()
})
it.each([undefined, ['in-process'], ['isolated']] as const)(
  'required refuses unsupported artifact or adapter without executing factory (%j)',
  async (support) => {
    const x = select('required', support ? [...support] : undefined)
    await expect(x.selector(id, id, dir, dir)).rejects.toMatchObject({ code: 'E_EXT_ISOLATION_UNAVAILABLE' })
    expect(x.prepare).not.toHaveBeenCalled()
    expect(x.setIsolation).toHaveBeenCalledWith(id, {
      mode: 'required',
      backend: 'unavailable',
      fallback: false,
      reason: expect.any(String),
    })
  },
)
it('preferred fallback requires explicit in-process compatibility', async () => {
  const no = select('preferred', ['isolated'])
  await expect(no.selector(id, id, dir, dir)).rejects.toMatchObject({ code: 'E_EXT_ISOLATION_UNAVAILABLE' })
  expect(no.prepare).not.toHaveBeenCalled()
  const yes = select('preferred', ['in-process', 'isolated'])
  await expect(yes.selector(id, id, dir, dir)).resolves.toBeTypeOf('function')
  expect(yes.prepare).toHaveBeenCalledOnce()
  expect(yes.audit).toHaveBeenCalledWith(
    'extension.isolation-fallback',
    expect.objectContaining({ reason: 'adapter-unavailable' }),
  )
})
it('off refuses isolated-only artifact before its factory runs', async () => {
  const x = select('off', ['isolated'])
  await expect(x.selector(id, id, dir, dir)).rejects.toMatchObject({ code: 'E_EXT_ISOLATION_UNAVAILABLE' })
  expect(x.prepare).not.toHaveBeenCalled()
})
it('preserves release-owned embedded manifest selection without filesystem discovery', async () => {
  const prepare = vi.fn((): ExtensionFactory => () => {})
  const selector = createExtensionFactorySelector({
    runtimeDirectory: '/no-runtime',
    target: 'darwin-arm64',
    modules: new Map([
      [
        id,
        {
          id,
          ecosystem: { [id]: prepare },
          embeddedExtensions: [
            { id, version: '1.0.0', apiRange: '^1.0', entry: './index.js', capabilities: {} },
          ],
        },
      ],
    ]),
    contextFor: () => ({}) as SeamInitContext,
    managed: { setIsolation: vi.fn(), fail: vi.fn() },
    audit: vi.fn(),
  })
  await expect(selector(id, id, '/no-package', '/no-extension')).resolves.toBeTypeOf('function')
  expect(prepare).toHaveBeenCalledOnce()
})
