import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sha256Hex } from '../src/hash.js'
import { AiSetupError, buildStamp, loadContractStore, NullContractStore } from '../src/index.js'

const ID = 'agnes-model-contract@0'
const fixture = fileURLToPath(new URL('../fixtures/contract/', import.meta.url))
const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function copy() {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-contract-'))
  dirs.push(dir)
  cpSync(fixture, dir, { recursive: true })
  return dir
}
function editManifest(dir: string, edit: (m: Record<string, unknown>) => void) {
  const p = join(dir, ID, 'manifest.json')
  const m = JSON.parse(readFileSync(p, 'utf8'))
  edit(m)
  writeFileSync(p, JSON.stringify(m))
}
function resign(dir: string, segment: 'tools' | 'syntax', text: string) {
  writeFileSync(join(dir, ID, `${segment}.json`), text)
  editManifest(dir, (m) => {
    ;(m.sha256 as Record<string, string>)[segment] = sha256Hex(text)
  })
}
const open = (dir = fixture) => loadContractStore({ dir, contractIds: [ID] })

describe('actual contract artifact loading', () => {
  it('loads all five real files, exposes exact immutable snapshot data and stamps the actual prefix hash', () => {
    const dir = copy(),
      store = open(dir)
    expect(new TextDecoder().decode(store.prefixBytes(ID))).toBe('You are Agnes.\n')
    expect(store.prefixHash(ID)).toBe(sha256Hex(readFileSync(join(dir, ID, 'prefix.bin'))))
    expect(store.tools(ID).map((t) => t.name)).toEqual(['shell', 'edit'])
    expect(store.syntax(ID)).toEqual({
      toolCallFormats: ['native', 'qwen3_coder'],
      thinkTag: { open: '<think>', close: '</think>' },
    })
    expect(store.manifest(ID).version).toBe(ID)
    expect(Object.isFrozen(store)).toBe(true)
    const bytes = store.prefixBytes(ID)
    bytes.fill(0)
    store.tools(ID)[0]?.parameters && Object.assign(store.tools(ID)[0] ?? {}, { name: 'changed' })
    const tools = store.tools(ID)
    tools[0]?.parameters && Object.assign(tools[0].parameters as object, { injected: true })
    tools.length = 0
    store.syntax(ID).toolCallFormats.push('changed')
    store.manifest(ID).sha256.prefix = 'changed'
    writeFileSync(join(dir, ID, 'prefix.bin'), 'tampered after loading')
    expect(new TextDecoder().decode(store.prefixBytes(ID))).toBe('You are Agnes.\n')
    expect(store.tools(ID).map((t) => t.name)).toEqual(['shell', 'edit'])
    expect(store.tools(ID)[0]?.parameters).not.toHaveProperty('injected')
    expect(store.syntax(ID).toolCallFormats).toEqual(['native', 'qwen3_coder'])
    expect(store.manifest(ID).sha256.prefix).toMatch(/^[0-9a-f]{64}$/)
    const stamp = buildStamp(
      {
        kind: 'inference',
        sessionKey: 's',
        slot: 'primary',
        contractId: ID,
        tools: [],
        route: 'r',
        model: 'm',
        derivedHash: 'a'.repeat(64),
        system: '',
        messages: [],
      },
      store,
      '1',
      { sentHash: 'b'.repeat(64), transforms: [] },
    )
    expect(stamp.prompt_prefix_hash).toBe(store.prefixHash(ID))
  })
  it('preserves empty and no-contract defaults and refuses unknown data lookups', () => {
    const store = loadContractStore({ dir: '/not/a/contract/directory', contractIds: [] })
    expect(store.prefixHash(null)).toBeNull()
    expect(store.prefixHash(ID)).toBeNull()
    for (const lookup of [
      () => store.prefixBytes(ID),
      () => store.tools(ID),
      () => store.syntax(ID),
      () => store.manifest(ID),
    ])
      expect(lookup).toThrow(AiSetupError)
    const none = new NullContractStore()
    expect(none.prefixHash(null)).toBeNull()
    expect(none.tools(ID)).toEqual([])
    expect(none.syntax(ID)).toEqual({ toolCallFormats: ['native'] })
    expect(() => none.prefixBytes(ID)).toThrow(/no contract loaded/)
  })
  it.each(['prefix', 'tools', 'syntax'] as const)(
    'refuses tampered raw %s bytes, then recovers when bytes restored',
    (segment) => {
      const dir = copy(),
        file = join(dir, ID, segment === 'prefix' ? 'prefix.bin' : `${segment}.json`),
        original = readFileSync(file)
      writeFileSync(file, Buffer.concat([original, Buffer.from(' ')]))
      expect(() => open(dir)).toThrow(AiSetupError)
      try {
        open(dir)
      } catch (e) {
        expect(e).toMatchObject({ code: 'CONTRACT_MISMATCH', detail: { contractId: ID, segment } })
      }
      writeFileSync(file, original)
      expect(open(dir).prefixHash(ID)).toMatch(/^[0-9a-f]{64}$/)
    },
  )
  it.each(['manifest.json', 'prefix.bin', 'tools.json', 'syntax.json', 'public.md'])(
    'refuses missing %s',
    (file) => {
      const dir = copy()
      rmSync(join(dir, ID, file))
      expect(() => open(dir)).toThrow(AiSetupError)
    },
  )
  it('rejects unknown directories, duplicate IDs and version mismatches', () => {
    expect(() => loadContractStore({ dir: fixture, contractIds: ['agnes-model-contract@7'] })).toThrow(
      AiSetupError,
    )
    expect(() => loadContractStore({ dir: fixture, contractIds: [ID, ID] })).toThrow(/duplicate/)
    const dir = copy()
    editManifest(dir, (m) => {
      m.version = 'agnes-model-contract@1'
    })
    expect(() => open(dir)).toThrow(/version/)
  })
  it('supports the deployed @vN identity spelling', () => {
    const dir = copy()
    const next = 'agnes-model-contract@v1'
    cpSync(join(dir, ID), join(dir, next), { recursive: true })
    const p = join(dir, next, 'manifest.json')
    const m = JSON.parse(readFileSync(p, 'utf8'))
    m.version = next
    writeFileSync(p, JSON.stringify(m))
    expect(loadContractStore({ dir, contractIds: [next] }).manifest(next).version).toBe(next)
  })
  it.each([
    '../escape',
    '/absolute',
    'agnes-model-contract@0/..',
    'agnes-model-contract@0\\..',
    'agnes-model-contract@0\n',
    'secret-token',
  ])('rejects malformed ID %j before directory resolution', (id) => {
    // A valid ID against this nonexistent directory would produce missing; malformed input must
    // instead take the ID branch before attempting to resolve or read a path.
    expect(() => loadContractStore({ dir: '/does/not/exist', contractIds: [id] })).toThrow(/"segment":"id"/)
    try {
      loadContractStore({ dir: '/does/not/exist', contractIds: [id] })
    } catch (e) {
      expect(String(e)).not.toContain(id)
    }
  })
  it.each(['directory', 'prefix.bin', 'tools.json', 'syntax.json', 'manifest.json', 'public.md'])(
    'refuses an escaping %s symlink',
    (which) => {
      const dir = copy(),
        outside = copy()
      if (which === 'directory') {
        rmSync(join(dir, ID), { recursive: true })
        const directoryLink = process.platform === 'win32' ? 'junction' : 'dir' // guards-allow-platform: actual directory alias on each OS.
        symlinkSync(join(outside, ID), join(dir, ID), directoryLink)
      } else {
        rmSync(join(dir, ID, which))
        symlinkSync(join(outside, ID, which), join(dir, ID, which))
      }
      expect(() => open(dir)).toThrow(/"segment":"path"/)
    },
  )
  it('wraps corrupt manifests without leaking their content', () => {
    const dir = copy()
    const marker = 'untrusted-private-text'
    writeFileSync(join(dir, ID, 'manifest.json'), `{${marker}`)
    try {
      open(dir)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(AiSetupError)
      expect(String(e)).not.toContain(marker)
      expect(String(e)).not.toContain(dir)
    }
  })
  it.each([
    { released_at: '2026-09-07' },
    { sha256: { prefix: 'wrong', tools: 'wrong', syntax: 'wrong' } },
    { unknown: 'secret' },
  ])('rejects a malformed manifest despite parseable JSON: %j', (patch) => {
    const dir = copy()
    editManifest(dir, (m) => Object.assign(m, patch))
    expect(() => open(dir)).toThrow(/manifest/)
  })
  it.each([
    '{broken',
    '{}',
    '[{"name":"shell"}]',
    '[{"name":"shell","description":"x","parameters":{},"extra":1}]',
  ])('rejects tools content with matching hash but invalid structure', (text) => {
    const dir = copy()
    resign(dir, 'tools', text)
    expect(() => open(dir)).toThrow(/"segment":"tools"/)
  })
  it.each([
    '{broken',
    '{}',
    '{"toolCallFormats":[]}',
    '{"toolCallFormats":[4]}',
    '{"toolCallFormats":["native"],"thinkTag":{"open":"x"}}',
    '{"toolCallFormats":["native"],"eval":"forbidden"}',
  ])('rejects invalid syntax with matching digest', (text) => {
    const dir = copy()
    resign(dir, 'syntax', text)
    expect(() => open(dir)).toThrow(/"segment":"syntax"/)
  })
})

it('rejects a non-UTF8 prefix even with a matching byte hash', () => {
  const dir = copy(),
    bytes = new Uint8Array([255, 254])
  writeFileSync(join(dir, ID, 'prefix.bin'), bytes)
  editManifest(dir, (m) => {
    ;(m.sha256 as Record<string, string>).prefix = sha256Hex(bytes)
  })
  expect(() => open(dir)).toThrow(/"segment":"prefix"/)
})
