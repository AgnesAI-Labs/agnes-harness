import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import type { PluginCapabilities } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { createPackageManager, emptyLock, parseSource, writeLock } from '../src/index.js'
import { inspectStaged } from '../src/inspect.js'
import { packPlugin } from '../src/plugin-pack.js'
import { readDevelopmentPlugin } from '../src/runtime-snapshots-development.js'
import { hashDirectory } from '../src/sources.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(
  options: {
    runtime?: string
    duplicate?: boolean
    legacy?: boolean
    escape?: boolean
    malformed?: boolean
    skinsOnly?: boolean
    emptyDescriptor?: boolean
    streams?: 'owner' | 'undeclared' | 'foreign'
    scope?: 'profile' | 'session'
    selfGranted?: boolean
    foreignRow?: boolean
    uiDenied?: boolean
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-client-descriptor-'))
  roots.push(dir)
  mkdirSync(join(dir, 'client'))
  writeFileSync(join(dir, 'index.mjs'), 'export const panel = { apply() {} }\n')
  writeFileSync(join(dir, 'client', 'index.js'), 'export function apply() {}\n')
  writeFileSync(
    join(dir, 'client', 'agnes.client.json'),
    JSON.stringify(
      options.emptyDescriptor
        ? {}
        : options.skinsOnly
          ? { skins: [{ id: 'example-skin', name: 'Example', css: './skin.css' }] }
          : {
              client: {
                entry: './index.js',
                services: ['panel.version'],
                ...(options.streams ? { streams: ['panel.events'] } : {}),
              },
              ...(options.selfGranted ? { capabilities: { streams: [stream(options.scope)] } } : {}),
            },
    ),
  )
  if (options.skinsOnly) writeFileSync(join(dir, 'client', 'skin.css'), 'body { color: red }\n')
  const rowId = 'ext:example/panel'
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'example-panel',
      version: '1.0.0',
      license: 'MIT',
      type: 'module',
      exports: './index.mjs',
      agnes: {
        plugins: [
          {
            apiRange: '^5.0.0',
            export: 'panel',
            id: rowId,
            runtime: options.runtime ?? 'in-process',
            ...(options.streams === 'owner'
              ? { capabilities: { ui: true, device: true, streams: [stream(options.scope)] } }
              : {}),
            ...(options.uiDenied ? { capabilities: { ui: false } } : {}),
          },
          ...(options.streams === 'foreign'
            ? [
                {
                  apiRange: '^5.0.0',
                  export: 'other',
                  id: 'ext:example/other',
                  capabilities: { streams: [stream(options.scope)] },
                },
              ]
            : []),
        ],
        clientDescriptors: options.malformed
          ? {}
          : options.duplicate
            ? [
                { rowId, path: './client/agnes.client.json' },
                { rowId, path: './client/agnes.client.json' },
              ]
            : [
                {
                  rowId: options.foreignRow ? 'ext:foreign/panel' : rowId,
                  path: './client/agnes.client.json',
                },
              ],
        ...(options.legacy ? { extensions: ['./extension'] } : {}),
      },
    }),
  )
  if (options.escape) {
    const outside = mkdtempSync(join(tmpdir(), 'agnes-client-escape-'))
    roots.push(outside)
    writeFileSync(join(outside, 'index.js'), 'export {}\n')
    rmSync(join(dir, 'client', 'index.js'))
    symlinkSync(join(outside, 'index.js'), join(dir, 'client', 'index.js'))
  }
  const inspect = async () =>
    inspectStaged({
      dir,
      source: { type: 'file', ref: 'file:./panel' },
      fetched: {
        dir,
        version: '1.0.0',
        license: 'MIT',
        integrity: hashDirectory(dir, { exclude: [] }),
        dependencies: {},
      },
      ceiling: ['ui', 'device', 'streams'],
    })
  return { inspect, rowId, dir }
}

function stream(
  scope: 'profile' | 'session' = 'profile',
): NonNullable<PluginCapabilities['streams']>[number] {
  return {
    name: 'panel.events',
    scope,
    lane: 'events',
    directions: ['outbound'],
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    maxFrameBytes: 1024,
    maxBufferedBytes: 2048,
    maxBytesPerSecond: 4096,
  }
}

it.each([undefined, 'profile', 'session'] as const)(
  'inspects, packs and installs a descriptor with owner stream scope %s',
  async (scope) => {
    const { inspect, rowId, dir } = fixture(scope ? { streams: 'owner', scope } : {})
    const { preview } = await inspect()
    expect(preview.contributions).toMatchObject([
      {
        kind: 'client',
        rowId,
        path: './client/agnes.client.json',
        client: { entry: 'index.js', services: ['panel.version'] },
      },
    ])
    expect(preview.contributions[0]?.id).toMatch(/^plugin\/[0-9a-f]{16}$/)
    expect(preview.blockers).toEqual([])
    expect((await readDevelopmentPlugin(dir, 'local-dev')).snapshot.contributions).toEqual(
      preview.contributions,
    )

    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-client-install-'))
    roots.push(dataDir)
    const profile = join(dataDir, 'profiles', 'local-dev')
    mkdirSync(profile, { recursive: true })
    writeLock(profile, {
      ...emptyLock('local-dev', '0.1.0'),
      resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
      seams: Object.fromEntries(
        ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((name) => [
          name,
          { provider: 'local' },
        ]),
      ),
      policySnapshot: {
        capabilityCeiling: ['ui', 'device', 'streams'],
        workspacePackages: 'require-project-trust',
      },
    })
    const archive = await packPlugin(dir, join(dataDir, 'panel.tgz'))
    const manager = createPackageManager({ dataDir, agnesVersion: '0.1.0', references: async () => [] })
    const source = parseSource(`file:${archive.split(sep).join('/')}`)
    const packed = await manager.inspect(profile, source)
    expect(packed.blockers).toEqual([])
    expect(packed.contributions).toEqual(preview.contributions)
    expect(packed.declaredCapabilities).toEqual(preview.declaredCapabilities)
    const entry = await manager.install(profile, source, { expectedIntegrity: packed.integrity })
    expect(entry.contributions).toEqual(preview.contributions)
    const decision = { integrity: packed.integrity, capabilityHash: packed.capabilityHash ?? '' }
    await manager.trust(profile, packed.id, decision)
    await manager.setEnabled(profile, packed.id, true)
    expect((await manager.inventory(profile)).packages[0]).toMatchObject({
      trusted: true,
      enabled: true,
      blockers: [],
    })
    const pin = await manager.pinRuntimeSnapshot(profile, {
      pinId: 'client-test',
      operationId: 'client-test',
      packageId: packed.id,
      purpose: 'turn',
      selector: {
        kind: 'installed',
        expectedIntegrity: entry.integrity,
        expectedTreeIntegrity: entry.treeIntegrity ?? '',
      },
    })
    expect(pin.snapshot.contributions).toEqual(preview.contributions)
    if (!scope) return

    // A valid declaration with a different scope still requires a fresh approval.
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    manifest.agnes.plugins[0].capabilities.streams[0].scope = scope === 'profile' ? 'session' : 'profile'
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    const changedSource = parseSource(`file:${dir.split(sep).join('/')}`)
    const changed = await manager.inspect(profile, changedSource)
    expect(changed.capabilityHash).not.toBe(packed.capabilityHash)
    expect(changed.capabilityDiff.added).toContain(
      `streams:${scope === 'profile' ? 'session' : 'profile'}:panel.events:events`,
    )
    const staleScopeDecision = { integrity: changed.integrity, capabilityHash: decision.capabilityHash }
    await manager.releaseRuntimePin(profile, {
      pinId: 'client-test',
      expectedSnapshotId: pin.snapshot.snapshotId,
    })
    await expect(
      manager.update(profile, packed.id, changedSource, {
        expectedIntegrity: changed.integrity,
        activation: { expectedInstalledIntegrity: packed.integrity, trust: staleScopeDecision },
      }),
    ).rejects.toMatchObject({ code: 'E_PACKAGE_TRUST' })
    await manager.update(profile, packed.id, changedSource, { expectedIntegrity: changed.integrity })
    await expect(manager.trust(profile, packed.id, staleScopeDecision)).rejects.toMatchObject({
      code: 'E_PACKAGE_TRUST',
    })
    await expect(manager.setEnabled(profile, packed.id, true)).rejects.toMatchObject({
      code: 'E_PACKAGE_TRUST',
    })
  },
)

it('accepts a skin-only descriptor without inventing a browser client', async () => {
  const { preview, rowId } = await (async () => {
    const input = fixture({ skinsOnly: true })
    return { preview: (await input.inspect()).preview, rowId: input.rowId }
  })()
  expect(preview.contributions).toMatchObject([{ kind: 'client', rowId, skins: [{ id: 'example-skin' }] }])
  expect(preview.contributions[0]).not.toHaveProperty('client')
})

it('rejects an empty descriptor', async () => {
  await expect(fixture({ emptyDescriptor: true }).inspect()).rejects.toThrow(
    expect.objectContaining({ detail: { reason: 'client-descriptor-content' } }),
  )
})

it.each([
  [{ duplicate: true }, 'duplicate-client-descriptor'],
  [{ runtime: 'isolated' }, 'client-descriptor-row'],
  [{ malformed: true }, 'client-descriptors'],
  [{ foreignRow: true }, 'client-descriptor-row'],
  [{ uiDenied: true }, 'client-descriptor-content'],
  [{ streams: 'undeclared' }, 'client-descriptor-content'],
  [{ streams: 'foreign' }, 'client-descriptor-content'],
  [{ streams: 'undeclared', selfGranted: true }, 'client-descriptor-content'],
] as const)('rejects invalid descriptor ownership %j', async (options, reason) => {
  const { inspect, dir } = fixture(options)
  await expect(inspect()).rejects.toThrow(
    expect.objectContaining({ detail: expect.objectContaining({ reason }) }),
  )
  const out = mkdtempSync(join(tmpdir(), 'agnes-client-refused-'))
  roots.push(out)
  await expect(packPlugin(dir, join(out, 'refused.tgz'))).rejects.toMatchObject({
    code: 'E_PACKAGE_STATE',
    ...('malformed' in options ? {} : { detail: { reason } }),
  })
})

it('rejects a descriptor combined with the old executable extension list with a migration hint', async () => {
  await expect(fixture({ legacy: true }).inspect()).rejects.toThrow(/migrate the backend to agnes.plugins/)
})

it('refuses a symlinked asset before it can enter an immutable snapshot', async () => {
  await expect(fixture({ escape: true }).inspect()).rejects.toThrow(/symbolic link/)
})

it('names only unsupported skin tokens in bounded structured inspection diagnostics', async () => {
  const { inspect, dir } = fixture({ skinsOnly: true })
  writeFileSync(
    join(dir, 'client/agnes.client.json'),
    JSON.stringify({
      skins: [
        {
          id: 'example-skin',
          name: 'Example',
          css: './skin.css',
          tokens: {
            '--agnes-text-primary': { light: 'red', dark: 'red' },
            '--agnes-text-secondary': { light: 'blue', dark: 'blue' },
            '--agnes-text-muted': { light: 'grey', dark: 'grey' },
          },
        },
      ],
    }),
  )
  await expect(inspect()).rejects.toMatchObject({
    detail: {
      diagnostics: [
        {
          code: 'unknown-theme-token',
          path: './client/agnes.client.json',
          field: 'skins.example-skin.tokens',
          name: '--agnes-text-muted',
        },
      ],
    },
  })
})
