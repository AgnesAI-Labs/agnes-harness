import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { inspectStaged } from '../src/inspect.js'
import { capabilityHash } from '../src/integrity.js'
import { emptyLock, writeLock } from '../src/lockfile.js'
import { createPackageManager } from '../src/manager.js'
import { capabilityPolicyBlockers, parsePluginCapabilities } from '../src/plugin-capabilities.js'
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
        plugins: [{ apiRange: '^1.4.0', export: 'main' }],
        capabilities: { network: ['api.example.com'], exec: ['node'] },
      },
    }),
  )
  writeFileSync(join(source, 'index.mjs'), 'export const main = {}')
  const lock = {
    ...emptyLock('test', '0.0.0'),
    seams: Object.fromEntries(
      [
        'approval',
        'checkpoint',
        'ledger',
        'sandbox',
        'verifier',
        'repair',
        'artifacts',
        'principals',
        'platform',
        'harness',
      ].map((key) => [key, '@agnes/base']),
    ),
    resolvedProfileHash: 'sha256-' + '0'.repeat(64),
  }
  writeLock(profile, lock)
  const manager = createPackageManager({ dataDir: join(root, 'data'), cwd: profile, agnesVersion: '0.0.0' })
  return { root, source, profile, manager }
}

it('binds declarations to previews/trust and rejects newly disallowed enable requests', async () => {
  const f = fixture(),
    source = parseSource('file:' + f.source)
  const preview = await f.manager.inspect(f.profile, source)
  expect(preview.declaredCapabilities).toEqual({ network: ['api.example.com'], exec: ['node'] })
  expect(preview.capabilityDiff.added).toContain('exec:node')
  await f.manager.install(f.profile, source, { expectedIntegrity: preview.integrity })
  await f.manager.trust(f.profile, preview.id, {
    integrity: preview.integrity,
    capabilityHash: preview.capabilityHash!,
  })
  const row = (await f.manager.inventory(f.profile)).packages[0]!
  const pin = await f.manager.pinRuntimeSnapshot(f.profile, {
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
  expect((await f.manager.inventory(f.profile)).packages[0]?.blockers).toContainEqual({
    code: 'policy',
    references: ['capability-blocked', 'network:api.example.com'],
  })
  await expect(f.manager.setEnabled(f.profile, preview.id, true)).rejects.toMatchObject({
    code: 'E_PACKAGE_BLOCKED',
  })
  expect((await f.manager.inspect(f.profile, source)).blockers[0]?.code).toBe('policy')
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
            agnes: { plugins: [{ apiRange: '^1.4.0', export: 'main' }] },
          }),
        )
      }
      return { stdout: '' }
    },
  })
  expect(fetched.source?.ref).toBe('git:https://example.com/plugin.git#' + commit)
  const preview = inspectStaged({ dir, fetched, source: fetched.source!, ceiling: [] }).preview
  expect(preview.source).toEqual(fetched.source)
  expect(preview.integrity).toBe(hashDirectory(dir))
})
