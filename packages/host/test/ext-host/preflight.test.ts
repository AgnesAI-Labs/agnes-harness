import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API_VERSION, type ExtensionManifest } from '@agnes/extension-api'
import { afterEach, expect, it } from 'vitest'
import { preflightExtension } from '../../src/ext-host/preflight.js'
import { manifestCapabilities } from '../../src/packages/capabilities.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const all = [
  'tools',
  'hooks',
  'slots',
  'resources',
  'network',
  'events',
  'tools.invoke',
  'artifacts',
  'subagent',
]
const manifest = (): ExtensionManifest => ({
  id: 'fixture/full',
  version: '1.0.0',
  apiRange: `^${API_VERSION}`,
  entry: './index.ts',
  capabilities: {
    tools: { prefix: '' },
    hooks: ['before_step'],
    slots: ['status.line'],
    resources: ['skill'],
    network: { hosts: ['example.test'] },
    events: true,
    'tools.invoke': true,
    artifacts: true,
    subagent: true,
  },
  lease: { budget: 3 },
  provides: ['artifacts'],
})
function setup(value: unknown = manifest()) {
  const root = mkdtempSync(join(tmpdir(), 'agnes-full-preflight-'))
  roots.push(root)
  const dir = join(root, 'extension')
  mkdirSync(dir)
  writeFileSync(join(dir, 'agnes.extension.json'), JSON.stringify(value))
  writeFileSync(join(dir, 'index.ts'), 'export default () => {}')
  return { root, dir, id: 'fixture/full', ceiling: all }
}

it('preserves the complete admitted manifest and resolves a canonical entry using the actual default API version', () => {
  const input = setup(),
    result = preflightExtension(input)
  expect(result.manifest).toEqual(manifest())
  expect(result.entry).toBe(realpathSync(join(input.dir, 'index.ts')))
  expect(manifestCapabilities(result.manifest)).toEqual(all)
})

it.each(all)(
  'refuses a missing %s category including empty tool prefix and non-tool authority',
  (category) => {
    const input = setup()
    expect(() =>
      preflightExtension({ ...input, ceiling: all.filter((value) => value !== category) }),
    ).toThrow(/E_CEILING_EXCEEDED/)
  },
)

it('does not treat empty lists or false flags as authority, and rejects unknown or accessor capabilities', () => {
  const empty = manifest()
  empty.capabilities = {
    hooks: [],
    slots: [],
    resources: [],
    network: [],
    events: false,
    'tools.invoke': false,
    artifacts: false,
    subagent: false,
  }
  expect(manifestCapabilities(empty)).toEqual([])
  empty.capabilities.network = { hosts: [] }
  expect(preflightExtension({ ...setup(empty), ceiling: [] }).manifest).toEqual(empty)
  expect(() =>
    manifestCapabilities({ ...empty, capabilities: { unlisted: true } } as unknown as ExtensionManifest),
  ).toThrow(/E_EXT_LOAD/)
  let reads = 0
  Object.defineProperty(empty.capabilities, 'events', {
    enumerable: true,
    get() {
      reads++
      return true
    },
  })
  expect(() => manifestCapabilities(empty)).toThrow(/E_EXT_LOAD/)
  expect(reads).toBe(0)
})

it('refuses identity mismatch, incompatible API and invalid full capability shapes', () => {
  expect(() => preflightExtension({ ...setup(), id: 'fixture/other' })).toThrow(/E_EXT_LOAD/)
  expect(() => preflightExtension(setup({ ...manifest(), apiRange: '^999.0.0' }))).toThrow(/E_API_RANGE/)
  expect(() =>
    preflightExtension(setup({ ...manifest(), capabilities: { network: ['example.test'] } })),
  ).toThrow(/E_EXT_LOAD/)
})

it('refuses actual symlink escape and malformed JSON without reflecting its source', () => {
  const input = setup(),
    outside = join(input.root, 'outside.ts')
  writeFileSync(outside, 'export default () => {}')
  symlinkSync(outside, join(input.dir, 'linked.ts'))
  writeFileSync(
    join(input.dir, 'agnes.extension.json'),
    JSON.stringify({ ...manifest(), entry: './linked.ts' }),
  )
  expect(() => preflightExtension(input)).toThrow(/E_EXT_LOAD/)
  writeFileSync(join(input.dir, 'agnes.extension.json'), '{"private":"SYNTHETIC-PRIVATE"')
  try {
    preflightExtension(input)
    throw new Error('expected refusal')
  } catch (error) {
    expect(String(error)).toContain('not valid JSON')
    expect(String(error)).not.toContain('SYNTHETIC-PRIVATE')
  }
})
