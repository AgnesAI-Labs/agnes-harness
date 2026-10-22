import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { inspectStaged } from '../src/inspect.js'
import { capabilityHash } from '../src/integrity.js'
import { emptyLock, writeLock } from '../src/lockfile.js'
import { createPackageManager } from '../src/manager.js'
import {
  capabilityAtoms,
  capabilityPolicyBlockers,
  mergePluginCapabilities,
  parsePluginCapabilities,
  readPluginCapabilities,
} from '../src/plugin-capabilities.js'
import { fetchSource, hashDirectory, parseSource } from '../src/sources.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agh-capabilities-'))
  roots.push(root)
  const source = join(root, 'outside-workspace'),
    profile = join(root, 'test')
  mkdirSync(source)
  mkdirSync(profile)
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'declared-tool',
      version: '1.0.0',
      license: 'MIT',
      exports: './index.mjs',
      agnes: {
        hostProvidedExternals: { '@agnes/plugin-runtime': '0.0.0' },
        plugins: [
          {
            apiRange: '^5.0.0',
            export: 'main',
            capabilities: { network: ['api.example.com'], exec: ['node'] },
          },
        ],
      },
    }),
  )
  writeFileSync(join(source, 'index.mjs'), 'export const main = {}')
  const lock = {
    ...emptyLock('test', '0.0.0'),
    seams: Object.fromEntries(
      ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((key) => [
        key,
        { provider: 'local' },
      ]),
    ),
    resolvedProfileHash: 'sha256-' + '0'.repeat(64),
  }
  writeLock(profile, lock)
  const manager = createPackageManager({ dataDir: join(root, 'data'), cwd: profile, agnesVersion: '0.0.0' })
  return { root, source, profile, manager }
}

it('emits a uiData atom for each manifest permission', () => {
  expect(capabilityAtoms({ ui: true, uiData: ['finance.differences.read'] })).toEqual([
    'ui',
    'uiData:finance.differences.read',
  ])
})

it('reviews transport declarations as authority and binds descriptor changes to trust hashes', () => {
  const stream = {
    name: 'sample.frames',
    scope: 'profile' as const,
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false as const },
    directions: ['outbound' as const],
    lane: 'media' as const,
    maxFrameBytes: 4096,
    maxBufferedBytes: 32768,
    maxBytesPerSecond: 122880,
  }
  const service = {
    id: 'sample',
    scope: 'profile' as const,
    artifact: { kind: 'node' as const, entry: './dist/server.mjs' },
    healthPath: '/health',
    listeners: [],
    startupTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
    apiVersion: '1.0.0',
    requires: [],
  }
  const declarations = {
    store: true,
    wake: true,
    streams: [stream],
    managedServices: [service],
    services: [
      {
        name: 'sample.status',
        scope: 'profile' as const,
        kind: 'query' as const,
        inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false as const },
        outputSchema: {},
        timeoutMs: 1000,
        maxResultBytes: 4096,
      },
    ],
  }
  expect(parsePluginCapabilities(declarations)).toEqual(declarations)
  expect(mergePluginCapabilities([declarations, declarations])).toEqual(declarations)
  expect(capabilityAtoms(declarations)).toEqual([
    'managedServices:profile:sample',
    'store',
    'streams:profile:sample.frames:media',
    'wake',
  ])
  expect(capabilityPolicyBlockers(declarations, { deny: ['streams:*'] })).toHaveLength(1)
  const f = fixture(),
    file = join(f.source, 'package.json'),
    manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.agnes.plugins = [
    { apiRange: '^5.0.0', export: 'main', capabilities: declarations },
    { apiRange: '^5.0.0', export: 'sibling', capabilities: { device: true, store: false, wake: false } },
  ]
  writeFileSync(file, JSON.stringify(manifest))
  expect(readPluginCapabilities(f.source, 'main')).toEqual(declarations)
  expect(readPluginCapabilities(f.source, 'sibling')).toEqual({ device: true, store: false, wake: false })
  expect(readPluginCapabilities(f.source)).toMatchObject({ device: true, store: true, wake: true })
  const old = capabilityHash({
    dependencies: {},
    declaredCapabilities: mergePluginCapabilities([declarations]) ?? {},
  })
  const changed = capabilityHash({
    dependencies: {},
    declaredCapabilities:
      mergePluginCapabilities([{ ...declarations, streams: [{ ...stream, maxFrameBytes: 8192 }] }]) ?? {},
  })
  expect(old).not.toBe(changed)
  expect(() =>
    parsePluginCapabilities({ streams: [{ ...stream, lane: 'control', directions: ['inbound'] }] }),
  ).toThrow('schema')
})

it('binds declarations to previews/trust and rejects newly disallowed enable requests', async () => {
  const f = fixture(),
    source = parseSource('file:' + f.source.split(sep).join('/'))
  const admitted = createPackageManager({
    dataDir: join(f.root, 'data'),
    cwd: f.profile,
    agnesVersion: '0.0.0',
    ceiling: ['exec', 'network'],
  })
  const preview = await admitted.inspect(f.profile, source)
  expect(preview.declaredCapabilities).toEqual({ network: ['api.example.com'], exec: ['node'] })
  expect(preview.capabilityDiff.added).toContain('exec:node')
  await admitted.install(f.profile, source, { expectedIntegrity: preview.integrity })
  await admitted.trust(f.profile, preview.id, {
    integrity: preview.integrity,
    capabilityHash: preview.capabilityHash!,
  })
  const row = (await admitted.inventory(f.profile)).packages[0]!
  const pin = await admitted.pinRuntimeSnapshot(f.profile, {
    pinId: 'declared-test',
    operationId: 'declared-test',
    packageId: preview.id,
    purpose: 'candidate',
    selector: {
      kind: 'installed',
      expectedIntegrity: preview.integrity,
      expectedTreeIntegrity: row.entry.treeIntegrity!,
    },
  })
  expect(pin.snapshot.capabilityHash).toBe(preview.capabilityHash)
  writeFileSync(join(f.profile, 'plugin-capabilities.json'), JSON.stringify({ deny: ['network:*'] }))
  expect((await admitted.inventory(f.profile)).packages[0]?.blockers).toContainEqual({
    code: 'policy',
    references: ['capability-blocked', 'network:api.example.com'],
  })
  await expect(admitted.setEnabled(f.profile, preview.id, true)).rejects.toMatchObject({
    code: 'E_PACKAGE_BLOCKED',
  })
  expect((await admitted.inspect(f.profile, source)).blockers[0]?.code).toBe('policy')
})

it('keeps legacy hashes, rejects malformed declarations/policies and covers wildcard requests conservatively', () => {
  const base = { contributions: [], dependencies: {} }
  expect(capabilityHash(base)).toBe(
    capabilityHash({ ...base, declaredCapabilities: undefined } as typeof base),
  )
  expect(capabilityHash({ ...base, declaredCapabilities: { model: true } })).not.toBe(capabilityHash(base))
  expect(() => parsePluginCapabilities({ exec: true })).toThrow('schema')
  expect(parsePluginCapabilities({ device: true })).toEqual({ device: true })
  expect(() => parsePluginCapabilities({ device: 'pump' })).toThrow('schema')
  expect(capabilityHash({ ...base, declaredCapabilities: { device: true } })).not.toBe(capabilityHash(base))
  expect(capabilityPolicyBlockers({ device: true }, { deny: ['device'] })).toHaveLength(1)
  expect(capabilityPolicyBlockers({ device: true }, { allow: ['device'] })).toEqual([])
  expect(capabilityPolicyBlockers({ network: ['*'] }, { deny: ['network:private.example'] })).toHaveLength(1)
  // A port-less host rule covers every port of that host; a ported rule stays specific to its port.
  expect(
    capabilityPolicyBlockers({ network: ['evil.example:443'] }, { deny: ['network:evil.example'] }),
  ).toHaveLength(1)
  expect(
    capabilityPolicyBlockers({ network: ['*.example:443'] }, { deny: ['network:evil.example'] }),
  ).toHaveLength(1)
  expect(
    capabilityPolicyBlockers({ network: ['evil.example:443'] }, { deny: ['network:evil.example:8443'] }),
  ).toEqual([])
  expect(
    capabilityPolicyBlockers({ network: ['evil.example.com:443'] }, { deny: ['network:evil.example'] }),
  ).toEqual([])
  expect(
    capabilityPolicyBlockers({ filesystem: { write: ['workspace/*'] } }, { allow: ['filesystem.read:*'] }),
  ).toHaveLength(1)
  expect(
    capabilityPolicyBlockers({ network: ['api.example.com'] }, { allow: ['network:*.example.com'] }),
  ).toEqual([])
})

it('pins an unqualified git URL in the preview without executing the plugin', async () => {
  const f = fixture(),
    commit = 'a'.repeat(40),
    dir = join(f.root, 'git-stage')
  const fetched = await fetchSource(parseSource('git:https://example.com/plugin.git'), dir, {
    cwd: f.root,
    npmProvenance: async () => undefined,
    exec: async (_command, args) => {
      if (args.includes('ls-remote')) return { stdout: commit + '\tHEAD\n' }
      if (args.includes('rev-parse')) return { stdout: commit + '\n' }
      if (args.includes('checkout')) {
        const target = args[args.indexOf('-C') + 1]!
        writeFileSync(
          join(target, 'package.json'),
          JSON.stringify({
            name: 'git-tool',
            version: '1.0.0',
            agnes: { plugins: [{ apiRange: '^5.0.0', export: 'main' }] },
          }),
        )
      }
      return { stdout: '' }
    },
  })
  expect(fetched.source?.ref).toBe('git:https://example.com/plugin.git#' + commit)
  const preview = (await inspectStaged({ dir, fetched, source: fetched.source!, ceiling: [] })).preview
  expect(preview.source).toEqual(fetched.source)
  expect(preview.integrity).toBe(hashDirectory(dir))
})

it('enforces the profile ceiling during inspection and install before executing package code', async () => {
  const f = fixture()
  const source = parseSource('file:' + f.source.split(sep).join('/'))
  const preview = await f.manager.inspect(f.profile, source)
  expect(preview.blockers).toContainEqual({
    code: 'policy',
    references: ['capability-ceiling', 'exec', 'network'],
  })
  await expect(
    f.manager.install(f.profile, source, { expectedIntegrity: preview.integrity }),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_BLOCKED' })
  expect((await f.manager.inventory(f.profile)).packages).toEqual([])
})
