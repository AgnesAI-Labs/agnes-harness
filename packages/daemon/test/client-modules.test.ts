import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InstalledInventory, InstalledPackage, PackageManager } from '@agnes/package-manager'
import {
  buildRuntimeTarget,
  createPluginRow,
  decodeRuntimeTargetArtifact,
  encodeRuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClientModuleRegistry, runtimeArtifactsFromStore } from '../src/packages/client-modules.js'
import { createPackageAdminService, type PackageActivationObservation } from '../src/packages/handler.js'
import { FilePackageOperationStore } from '../src/packages/operations.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agnes-client-modules-'))
  roots.push(root)
  const packageDirectory = join(root, 'installed')
  const snapshots = join(root, 'snapshots')
  mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
  writeFileSync(join(packageDirectory, 'dist', 'index.js'), 'export const value = "v1"\n')
  writeFileSync(join(packageDirectory, 'dist', 'index.css'), '.panel { color: red }\n')
  return { root, packageDirectory, snapshots }
}

function installed(input: {
  directory: string
  integrity?: string
  enabled?: boolean
  trusted?: boolean
  blockers?: InstalledPackage['blockers']
  backend?: boolean
  entry?: string
  styles?: string[]
  slots?: string[]
  publicConfig?: Record<string, unknown>
  services?: string[]
  slotCatalogVersion?: string
}): InstalledPackage {
  const integrity = input.integrity ?? `sha256-${'1'.repeat(64)}`
  return {
    id: 'acme/panel',
    directory: input.directory,
    entry: { integrity },
    capabilityHash: 'capability',
    enabled: input.enabled ?? true,
    trusted: input.trusted ?? true,
    blockers: input.blockers ?? [],
    verifiedRollbackTarget: null,
    contributions: [
      {
        kind: 'extension',
        id: 'acme/panel',
        path: './agnes.extension.json',
        apiRange: '*',
        capabilities: input.backend ? { ui: ['client'], tools: { prefix: 'panel_' } } : { ui: ['client'] },
        client: {
          entry: input.entry ?? 'dist/index.js',
          styles: input.styles ?? ['dist/index.css'],
          slots: input.slots ?? ['workbench.panel'],
          ...(input.publicConfig === undefined ? {} : { publicConfig: input.publicConfig }),
          ...(input.slotCatalogVersion === undefined ? {} : { slotCatalogVersion: input.slotCatalogVersion }),
          services: input.services ?? [],
          projections: [],
        },
      },
    ],
  } as unknown as InstalledPackage
}

function inventory(row: InstalledPackage): InstalledInventory {
  return { profile: 'local-dev', hash: 'inventory', packages: [row] }
}

const running = (integrity: string): PackageActivationObservation => ({
  actual: 'running',
  actualIntegrity: integrity,
})

function webArtifact(packageId: string, revision: string, disabled = false) {
  return encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows: [
        createPluginRow({
          id: `web:${packageId}`,
          plugin: `${packageId}@${revision}/client`,
          snapshotDigest: revision,
          exportName: 'client',
          entryRevision: revision,
          extrasRevision: 'none',
          mountRevision: 'host-web-row:v1',
          runtime: 'in-process',
          disabled,
        }),
      ],
      resources: { mcp: [], skills: {} },
      resourceRevision: 'a'.repeat(64),
      compositeRevision: 'b'.repeat(64),
    }),
  )
}

describe('client module immutable snapshots', () => {
  it('binds a row-owned client descriptor to its plugin service identity', async () => {
    const files = fixture()
    const base = installed({ directory: files.packageDirectory, backend: true })
    const owner = 'plugin/0123456789abcdef'
    const row = {
      ...base,
      contributions: [
        {
          kind: 'client' as const,
          id: owner,
          rowId: 'ext:acme/panel',
          path: './agnes.client.json',
          client: { entry: './dist/index.js', services: ['panel.search'] },
        },
      ],
    } as InstalledPackage
    const web = decodeRuntimeTargetArtifact(webArtifact(row.id, row.entry.integrity)).tree.rows[0]
    if (!web) throw new Error('missing web row')
    const backend = createPluginRow({
      id: 'ext:acme/panel',
      plugin: `${row.id}@${row.entry.integrity}/panel`,
      snapshotDigest: row.entry.integrity,
      exportName: 'panel',
      entryRevision: row.entry.integrity,
      extrasRevision: 'none',
      mountRevision: 'host-ordinary-row:v1',
      runtime: 'in-process',
    })
    let backendDisabled = false
    const artifact = () =>
      encodeRuntimeTargetArtifact(
        buildRuntimeTarget({
          rows: [web, { ...backend, disabled: backendDisabled }],
          resources: { mcp: [], skills: {} },
          resourceRevision: 'a'.repeat(64),
          compositeRevision: 'b'.repeat(64),
        }),
      )
    const registry = createClientModuleRegistry({
      snapshotDirectory: () => files.snapshots,
      runtimeArtifacts: () => ({ desired: artifact(), lastGood: artifact() }),
    })
    const roster = await registry.list({
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: inventory(row),
      actual: async () => running(row.entry.integrity),
      refreshInventory: async () => inventory(row),
    })
    expect(roster.rows).toMatchObject([
      {
        moduleName: owner,
        extIds: [owner],
        services: ['panel.search'],
        phase: 'ready',
      },
    ])
    backendDisabled = true
    const disabled = await registry.list({
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: inventory(row),
      actual: async () => running(row.entry.integrity),
      refreshInventory: async () => inventory(row),
    })
    expect(disabled.rows).toEqual([])
    registry.close()
  })

  it('projects desired, previous, and lastGood runtime artifacts for supervisor wiring', () => {
    const desired = webArtifact('acme/panel', `sha256-${'1'.repeat(64)}`)
    const previous = webArtifact('acme/panel', `sha256-${'2'.repeat(64)}`)
    const lastGood = webArtifact('acme/panel', `sha256-${'3'.repeat(64)}`)
    const store = { desired: () => desired, previous: () => previous, lastGood: () => lastGood }

    expect(runtimeArtifactsFromStore(store)).toEqual({ desired, previous, lastGood })
    expect(runtimeArtifactsFromStore(undefined)).toBeUndefined()
  })

  it('revokes snapshots for an inventory-blocked package instead of serving stale bytes', async () => {
    const files = fixture()
    const row = installed({ directory: files.packageDirectory })
    const registry = createClientModuleRegistry({ snapshotDirectory: () => files.snapshots })
    const input = {
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: inventory(row),
      actual: async () => undefined,
      refreshInventory: async () => inventory(row),
    }
    const first = await registry.list(input)
    expect(first.modules).toHaveLength(1)
    const blocked = installed({
      directory: files.packageDirectory,
      blockers: [{ code: 'incompatible', references: ['reserved-row-id:web:'] }],
    })
    const revoked = await registry.list({
      ...input,
      inventory: inventory(blocked),
      refreshInventory: async () => inventory(blocked),
    })
    expect(revoked.modules).toEqual([])
    expect(revoked.statuses).toEqual([])
    expect(
      await registry.read({
        ...input,
        inventory: inventory(blocked),
        path: first.modules[0]?.entryUrl ?? '',
      }),
    ).toEqual({
      found: false,
    })
    registry.close()
  })

  it('publishes a UI-only package, returns route bytes, and reports restart recovery', async () => {
    const files = fixture()
    const row = installed({ directory: files.packageDirectory })
    const events: string[] = []
    const registry = createClientModuleRegistry({
      snapshotDirectory: () => files.snapshots,
      changed: (event) => events.push(event.reason),
    })
    const input = {
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: inventory(row),
      actual: async () => undefined,
      refreshInventory: async () => inventory(row),
    }

    const roster = await registry.list(input)
    expect(roster.modules).toHaveLength(1)
    expect(roster.modules[0]).toMatchObject({
      packageId: 'acme/panel',
      revision: row.entry.integrity,
      entryUrl: `/plugins/acme/panel/${row.entry.integrity}/dist/index.js`,
      styleUrls: [`/plugins/acme/panel/${row.entry.integrity}/dist/index.css`],
      slots: ['workbench.panel'],
      extIds: [],
    })
    expect(roster.modules[0]?.contentDigest).toMatch(/^sha256-[a-f0-9]{64}$/)
    const manifest = JSON.parse(
      readFileSync(
        join(files.snapshots, 'acme', 'panel', encodeURIComponent(row.entry.integrity), '_snapshot.json'),
        'utf8',
      ),
    ) as { version: number; contentDigest: string; rows: Array<Record<string, unknown>> }
    expect(manifest).toMatchObject({
      version: 2,
      contentDigest: roster.modules[0]?.contentDigest,
      rows: [
        {
          rowId: 'web:acme/panel',
          entry: 'dist/index.js',
          styles: ['dist/index.css'],
          parentChildVersion: 'dsh-parent-child/v1',
          contentDigest: roster.modules[0]?.contentDigest,
        },
      ],
    })
    expect(roster.statuses).toEqual([
      {
        packageId: 'acme/panel',
        installedRevision: row.entry.integrity,
        backendRevision: null,
        state: 'ready',
      },
    ])
    expect(events).toEqual(['rebuilt'])
    const module = roster.modules[0]
    if (!module) throw new Error('missing ready client module')
    expect(await registry.read({ ...input, path: module.entryUrl })).toEqual({
      found: true,
      base64: Buffer.from('export const value = "v1"\n').toString('base64'),
    })

    const restartedEvents: string[] = []
    const restarted = createClientModuleRegistry({
      snapshotDirectory: () => files.snapshots,
      changed: (event) => restartedEvents.push(event.reason),
    })
    expect((await restarted.list(input)).modules).toEqual(roster.modules)
    expect(restartedEvents).toEqual(['rebuilt'])
    registry.close()
    restarted.close()
  })

  it('uses lastGood/desired web rows for the roster and fails closed on trust revocation', async () => {
    const files = fixture()
    const row = installed({ directory: files.packageDirectory, enabled: false })
    const artifact = webArtifact(row.id, row.entry.integrity)
    const registry = createClientModuleRegistry({
      snapshotDirectory: () => files.snapshots,
      runtimeArtifacts: () => ({ desired: artifact, lastGood: artifact }),
    })
    const input = {
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: inventory(row),
      actual: async () => undefined,
      refreshInventory: async () => inventory(row),
    }
    const fromTree = await registry.list(input)
    expect(fromTree.modules).toHaveLength(1)
    const untrusted = installed({ directory: files.packageDirectory, enabled: false, trusted: false })
    const revoked = await registry.list({ ...input, inventory: inventory(untrusted) })
    expect(revoked.modules).toEqual([])
    const module = fromTree.modules[0]
    if (!module) throw new Error('missing tree-selected module')
    expect(await registry.read({ ...input, inventory: inventory(untrusted), path: module.entryUrl })).toEqual(
      {
        found: false,
      },
    )
    registry.close()
  })

  it('keeps a scoped package whose name begins with client in the artifact-derived roster', async () => {
    const files = fixture()
    const base = installed({ directory: files.packageDirectory, enabled: false })
    const packageId = '@agnes-examples/client-panel'
    const row = {
      ...base,
      id: packageId,
      contributions: base.contributions.map((contribution) =>
        contribution.kind === 'extension' ? { ...contribution, id: 'examples/client-panel' } : contribution,
      ),
    } as InstalledPackage
    const artifact = webArtifact(packageId, row.entry.integrity)
    const registry = createClientModuleRegistry({
      snapshotDirectory: () => files.snapshots,
      runtimeArtifacts: () => ({ desired: artifact, lastGood: artifact }),
    })
    const roster = await registry.list({
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: inventory(row),
      actual: async () => undefined,
      refreshInventory: async () => inventory(row),
    })
    expect(roster.rows ?? []).toHaveLength(1)
    expect(roster.rows?.[0]).toMatchObject({ packageId, phase: 'ready', enabled: true })
    registry.close()
  })

  it('publishes independent browser rows for two client extensions in one package', async () => {
    const files = fixture()
    writeFileSync(join(files.packageDirectory, 'dist', 'secondary.js'), 'export const value = "secondary"\n')
    writeFileSync(join(files.packageDirectory, 'dist', 'secondary.css'), '.secondary { color: blue }\n')
    const base = installed({ directory: files.packageDirectory })
    const primary = base.contributions[0]
    if (primary?.kind !== 'extension') throw new Error('missing fixture extension')
    const row = {
      ...base,
      contributions: [
        { ...primary, id: 'acme/primary' },
        {
          ...primary,
          id: 'acme/secondary',
          client: {
            ...primary.client,
            entry: 'dist/secondary.js',
            styles: ['dist/secondary.css'],
            slots: ['workbench.panel'],
          },
        },
      ],
    } as unknown as InstalledPackage
    const registry = createClientModuleRegistry({ snapshotDirectory: () => files.snapshots })
    const input = {
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: inventory(row),
      actual: async () => undefined,
      refreshInventory: async () => inventory(row),
    }
    const roster = await registry.list(input)
    expect(roster.modules.map((module) => module.rowId).sort()).toEqual([
      'web:acme/panel:acme/primary',
      'web:acme/panel:acme/secondary',
    ])
    expect(roster.rows?.map((item) => [item.rowId, item.moduleName, item.packageId]).sort()).toEqual([
      ['web:acme/panel:acme/primary', 'acme/primary', 'acme/panel'],
      ['web:acme/panel:acme/secondary', 'acme/secondary', 'acme/panel'],
    ])
    expect(roster.modules).toHaveLength(2)
    expect(roster.modules.every((module) => /^sha256-[a-f0-9]{64}$/.test(module.contentDigest ?? ''))).toBe(
      true,
    )
    expect(roster.rows?.every((item) => /^sha256-[a-f0-9]{64}$/.test(item.contentDigest ?? ''))).toBe(true)
    const second = roster.modules.find((module) => module.rowId?.endsWith('acme/secondary'))
    expect(second?.entryUrl).toContain('/dist/secondary.js')
    expect(await registry.read({ ...input, path: second?.entryUrl ?? '' })).toMatchObject({ found: true })
    registry.close()
  })

  it('persists a unique legacy single-row migration when a package gains another client contribution', async () => {
    const files = fixture()
    writeFileSync(join(files.packageDirectory, 'dist', 'secondary.js'), 'export const value = "secondary"\n')
    writeFileSync(join(files.packageDirectory, 'dist', 'secondary.css'), '.secondary { color: blue }\n')
    const base = installed({ directory: files.packageDirectory })
    const primary = base.contributions[0]
    if (primary?.kind !== 'extension') throw new Error('missing fixture extension')
    const registry = createClientModuleRegistry({ snapshotDirectory: () => files.snapshots })
    const input = {
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: inventory(base),
      actual: async () => undefined,
      refreshInventory: async () => inventory(base),
    }
    await registry.list(input)
    const next = {
      ...base,
      entry: { ...base.entry, integrity: `sha256-${'2'.repeat(64)}` },
      contributions: [
        primary,
        {
          ...primary,
          id: 'acme/secondary',
          client: { ...primary.client, entry: 'dist/secondary.js', styles: ['dist/secondary.css'] },
        },
      ],
    } as unknown as InstalledPackage
    const roster = await registry.list({
      ...input,
      inventory: inventory(next),
      refreshInventory: async () => inventory(next),
    })

    expect(roster.rowAliases).toEqual({
      'web:acme/panel': 'web:acme/panel:acme/panel',
    })
    expect(roster.modules.map((module) => module.rowId).sort()).toEqual([
      'web:acme/panel:acme/panel',
      'web:acme/panel:acme/secondary',
    ])
    const saved = JSON.parse(readFileSync(join(files.snapshots, '_client-modules.json'), 'utf8')) as {
      packages: Record<string, { rowAliases?: Record<string, string> }>
    }
    expect(saved.packages['acme/panel']?.rowAliases).toEqual(roster.rowAliases)
    registry.close()
  })

  it('blocks activation when one legacy row is explicitly claimed by multiple new contributions', async () => {
    const files = fixture()
    writeFileSync(join(files.packageDirectory, 'dist', 'secondary.js'), 'export const value = "secondary"\n')
    const base = installed({ directory: files.packageDirectory })
    const primary = base.contributions[0]
    if (primary?.kind !== 'extension') throw new Error('missing fixture extension')
    const registry = createClientModuleRegistry({ snapshotDirectory: () => files.snapshots })
    const input = {
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: inventory(base),
      actual: async () => undefined,
      refreshInventory: async () => inventory(base),
    }
    await registry.list(input)
    const next = {
      ...base,
      entry: { ...base.entry, integrity: `sha256-${'3'.repeat(64)}` },
      contributions: [
        {
          ...primary,
          id: 'acme/primary',
          client: { ...primary.client, legacyRowIds: ['web:acme/panel'] },
        },
        {
          ...primary,
          id: 'acme/secondary',
          client: {
            ...primary.client,
            entry: 'dist/secondary.js',
            legacyRowIds: ['web:acme/panel'],
          },
        },
      ],
    } as unknown as InstalledPackage
    const roster = await registry.list({
      ...input,
      inventory: inventory(next),
      refreshInventory: async () => inventory(next),
    })

    expect(roster.modules).toEqual([])
    expect(roster.rows).toEqual([])
    expect(roster.statuses).toMatchObject([
      { packageId: 'acme/panel', state: 'blocked', reason: 'resources-invalid' },
    ])
    registry.close()
  })

  it('blocks a browser row with an unsupported slot before publishing its immutable snapshot', async () => {
    const files = fixture()
    const row = installed({ directory: files.packageDirectory, slots: ['sidebar.action'] })
    const registry = createClientModuleRegistry({ snapshotDirectory: () => files.snapshots })
    const input = {
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: inventory(row),
      actual: async () => undefined,
      refreshInventory: async () => inventory(row),
    }

    const result = await registry.list(input)

    expect(result.modules).toEqual([])
    expect(result.statuses[0]).toMatchObject({
      packageId: row.id,
      state: 'blocked',
      reason: 'unsupported-slot',
    })
    expect(result.rows).toEqual([])
    registry.close()
  })

  it('keeps declared host-owned UI regions eligible for browser publication', async () => {
    const files = fixture()
    const row = installed({ directory: files.packageDirectory, slots: ['ui:sidebar'] })
    const registry = createClientModuleRegistry({ snapshotDirectory: () => files.snapshots })
    const result = await registry.list({
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: inventory(row),
      actual: async () => undefined,
      refreshInventory: async () => inventory(row),
    })

    expect(result.statuses[0]).toMatchObject({ state: 'ready' })
    expect(result.modules[0]?.slots).toEqual(['ui:sidebar'])
    registry.close()
  })

  it('publishes a supported DSH sidebar slot only with the matching catalog version', async () => {
    const files = fixture()
    const inputFor = (slotCatalogVersion?: string) => {
      const row = installed({
        directory: files.packageDirectory,
        slots: ['sidebar.footer.action'],
        ...(slotCatalogVersion === undefined ? {} : { slotCatalogVersion }),
      })
      return {
        profile: 'local-dev',
        profileDirectory: files.root,
        inventory: inventory(row),
        actual: async () => undefined,
        refreshInventory: async () => inventory(row),
      }
    }
    const registry = createClientModuleRegistry({ snapshotDirectory: () => files.snapshots })

    expect((await registry.list(inputFor())).statuses[0]).toMatchObject({
      state: 'blocked',
      reason: 'unsupported-slot',
    })
    expect((await registry.list(inputFor('dsh-client-slots/v2'))).statuses[0]).toMatchObject({
      state: 'blocked',
      reason: 'unsupported-slot',
    })
    expect((await registry.list(inputFor('dsh-client-slots/v1'))).modules[0]?.slots).toEqual([
      'sidebar.footer.action',
    ])
    registry.close()
  })

  it('retains a disabled/deleted client snapshot while desired or lastGood references it', async () => {
    const files = fixture()
    const row = installed({ directory: files.packageDirectory })
    const enabledArtifact = webArtifact(row.id, row.entry.integrity)
    const disabledArtifact = webArtifact(row.id, row.entry.integrity, true)
    let refs: { desired?: typeof enabledArtifact; lastGood?: typeof enabledArtifact } = {
      desired: enabledArtifact,
      lastGood: enabledArtifact,
    }
    const registry = createClientModuleRegistry({
      snapshotDirectory: () => files.snapshots,
      retentionMs: 1,
      runtimeArtifacts: () => refs,
    })
    const input = {
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: inventory(row),
      actual: async () => undefined,
      refreshInventory: async () => inventory(row),
    }
    const first = await registry.list(input)
    const module = first.modules[0]
    if (!module) throw new Error('missing initial module')
    refs = { desired: disabledArtifact, lastGood: disabledArtifact }
    const disabled = installed({ directory: files.packageDirectory, enabled: false })
    expect((await registry.list({ ...input, inventory: inventory(disabled) })).modules).toEqual([])
    expect(
      await registry.read({
        ...input,
        inventory: { ...inventory(disabled), packages: [] },
        path: module.entryUrl,
      }),
    ).toMatchObject({
      found: true,
    })
    refs = {
      desired: encodeRuntimeTargetArtifact(
        buildRuntimeTarget({
          rows: [],
          resources: { mcp: [], skills: {} },
          resourceRevision: 'c'.repeat(64),
          compositeRevision: 'd'.repeat(64),
        }),
      ),
    }
    await registry.list({ ...input, inventory: inventory(disabled) })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(
      await registry.read({
        ...input,
        inventory: { ...inventory(disabled), packages: [] },
        path: module.entryUrl,
      }),
    ).toEqual({ found: false })
    registry.close()
  })

  it('copies relative dynamic imports into the same immutable snapshot', async () => {
    const files = fixture()
    writeFileSync(
      join(files.packageDirectory, 'dist', 'index.js'),
      [
        '// import("./commented-out.js")',
        'const ordinary = "import(\\"./string-only.js\\")"',
        'export const load = () => import("./chunk.js")',
        'export { ordinary }',
        '',
      ].join('\n'),
    )
    writeFileSync(
      join(files.packageDirectory, 'dist', 'index.css'),
      '/* @import "./commented-out.css"; */\n.panel { color: red }\n',
    )
    writeFileSync(join(files.packageDirectory, 'dist', 'chunk.js'), 'export const chunk = 42\n')
    const row = installed({ directory: files.packageDirectory })
    const currentInventory = inventory(row)
    const registry = createClientModuleRegistry({ snapshotDirectory: () => files.snapshots })
    const input = {
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: currentInventory,
      actual: async () => undefined,
      refreshInventory: async () => currentInventory,
    }
    await registry.list(input)
    expect(
      await registry.read({
        ...input,
        path: `/plugins/acme/panel/${row.entry.integrity}/dist/chunk.js`,
      }),
    ).toEqual({ found: true, base64: Buffer.from('export const chunk = 42\n').toString('base64') })
    registry.close()
  })

  it('serves only files declared by the verified snapshot manifest', async () => {
    const files = fixture()
    const row = installed({ directory: files.packageDirectory })
    const currentInventory = inventory(row)
    const registry = createClientModuleRegistry({ snapshotDirectory: () => files.snapshots })
    const input = {
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: currentInventory,
      actual: async () => undefined,
      refreshInventory: async () => currentInventory,
    }
    await registry.list(input)
    const revisionDirectory = join(files.snapshots, 'acme', 'panel', row.entry.integrity)
    writeFileSync(join(revisionDirectory, 'dist', 'undeclared.js'), 'export const leaked = true\n')
    expect(
      await registry.read({
        ...input,
        path: `/plugins/acme/panel/${row.entry.integrity}/dist/undeclared.js`,
      }),
    ).toEqual({ found: false })
    registry.close()
  })

  it('encodes every asset path segment and reads names containing URL delimiters and Unicode', async () => {
    const files = fixture()
    // Question marks are URL delimiters but are not legal Windows filename characters. The
    // Windows fixture still covers spaces, Unicode, fragment and percent delimiters.
    const entry = process.platform === 'win32' ? 'dist/空 格#%.mjs' : 'dist/空 格?#%.mjs'
    mkdirSync(join(files.packageDirectory, 'dist'), { recursive: true })
    writeFileSync(join(files.packageDirectory, entry), 'export const encoded = true\n')
    const row = installed({ directory: files.packageDirectory, entry, styles: [] })
    const currentInventory = inventory(row)
    const registry = createClientModuleRegistry({ snapshotDirectory: () => files.snapshots })
    const input = {
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: currentInventory,
      actual: async () => undefined,
      refreshInventory: async () => currentInventory,
    }
    const result = await registry.list(input)
    const entryUrl = result.modules[0]?.entryUrl
    const encodedEntry = entry.split('/').map(encodeURIComponent).join('/')
    expect(entryUrl).toBe(`/plugins/acme/panel/${row.entry.integrity}/${encodedEntry}`)
    if (!entryUrl) throw new Error('missing encoded entry URL')
    expect(await registry.read({ ...input, path: entryUrl })).toMatchObject({ found: true })
    registry.close()
  })

  it('requires the observed backend revision before publishing a backend-coupled module', async () => {
    const files = fixture()
    const row = installed({ directory: files.packageDirectory, backend: true })
    const registry = createClientModuleRegistry({ snapshotDirectory: () => files.snapshots })
    const base = {
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: inventory(row),
      refreshInventory: async () => inventory(row),
    }

    expect((await registry.list({ ...base, actual: async () => undefined })).statuses[0]).toMatchObject({
      state: 'blocked',
      reason: 'backend-revision-unavailable',
    })
    expect(
      (
        await registry.list({
          ...base,
          actual: async () => running(`sha256-${'0'.repeat(64)}`),
        })
      ).statuses[0],
    ).toMatchObject({ state: 'pending-activation' })
    const ready = await registry.list({
      ...base,
      actual: async () => running(row.entry.integrity),
    })
    expect(ready.statuses[0]).toMatchObject({ state: 'ready', backendRevision: row.entry.integrity })
    expect(ready.modules[0]?.extIds).toEqual(['acme/panel'])
    registry.close()
  })

  it('keeps backendRevision null for a UI-only package even when activation reports a digest', async () => {
    const files = fixture()
    const row = installed({ directory: files.packageDirectory })
    const registry = createClientModuleRegistry({ snapshotDirectory: () => files.snapshots })
    const result = await registry.list({
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: inventory(row),
      actual: async () => running(row.entry.integrity),
      refreshInventory: async () => inventory(row),
    })
    expect(result.statuses[0]).toMatchObject({ state: 'ready', backendRevision: null })
    registry.close()
  })

  it('retains a replaced snapshot for exactly the grace window and then refuses it', async () => {
    const files = fixture()
    let now = new Date('2026-09-18T00:00:00.000Z')
    let row = installed({ directory: files.packageDirectory })
    let currentInventory = inventory(row)
    const registry = createClientModuleRegistry({
      snapshotDirectory: () => files.snapshots,
      clock: () => now,
      retentionMs: 1_000,
    })
    const input = () => ({
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: currentInventory,
      actual: async () => undefined,
      refreshInventory: async () => currentInventory,
    })
    const first = await registry.list(input())
    const firstModule = first.modules[0]
    if (!firstModule) throw new Error('missing first client module')
    const oldUrl = firstModule.entryUrl

    writeFileSync(join(files.packageDirectory, 'dist', 'index.js'), 'export const value = "v2"\n')
    row = installed({ directory: files.packageDirectory, integrity: `sha256-${'2'.repeat(64)}` })
    currentInventory = inventory(row)
    const second = await registry.list(input())
    expect(second.statuses[0]?.retained).toEqual([
      { revision: `sha256-${'1'.repeat(64)}`, expiresAt: '2026-09-18T00:00:01.000Z' },
    ])
    expect(await registry.read({ ...input(), path: oldUrl })).toMatchObject({ found: true })

    now = new Date('2026-09-18T00:00:01.001Z')
    await registry.list(input())
    expect(await registry.read({ ...input(), path: oldUrl })).toEqual({ found: false })
    registry.close()
  })

  it('removes a rollback target from retained before making it current again', async () => {
    const files = fixture()
    let now = new Date('2026-09-18T00:00:00.000Z')
    const v1 = installed({ directory: files.packageDirectory })
    let currentInventory = inventory(v1)
    const registry = createClientModuleRegistry({
      snapshotDirectory: () => files.snapshots,
      clock: () => now,
      retentionMs: 1_000,
    })
    const input = () => ({
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: currentInventory,
      actual: async () => undefined,
      refreshInventory: async () => currentInventory,
    })
    await registry.list(input())
    now = new Date('2026-09-18T00:00:00.100Z')
    writeFileSync(join(files.packageDirectory, 'dist', 'index.js'), 'export const value = "v2"\n')
    const v2 = installed({ directory: files.packageDirectory, integrity: `sha256-${'2'.repeat(64)}` })
    currentInventory = inventory(v2)
    await registry.list(input())
    now = new Date('2026-09-18T00:00:00.200Z')
    writeFileSync(join(files.packageDirectory, 'dist', 'index.js'), 'export const value = "v1"\n')
    currentInventory = inventory(v1)
    const rolledBack = await registry.list(input())
    expect(rolledBack.statuses[0]?.retained?.map((item) => item.revision)).toEqual([v2.entry.integrity])

    now = new Date('2026-09-18T00:00:01.101Z')
    const afterOldV1Expiry = await registry.list(input())
    expect(afterOldV1Expiry.modules[0]?.revision).toBe(v1.entry.integrity)
    registry.close()
  })

  it('refuses a generation before publication when the retained snapshot limit is full', async () => {
    const files = fixture()
    let row = installed({ directory: files.packageDirectory })
    let currentInventory = inventory(row)
    const registry = createClientModuleRegistry({ snapshotDirectory: () => files.snapshots })
    const input = () => ({
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: currentInventory,
      actual: async () => undefined,
      refreshInventory: async () => currentInventory,
    })
    await registry.list(input())
    for (const digit of ['2', '3', '4', '5', '6', '7', '8', '9']) {
      writeFileSync(join(files.packageDirectory, 'dist', 'index.js'), `export const value = "v${digit}"\n`)
      row = installed({ directory: files.packageDirectory, integrity: `sha256-${digit.repeat(64)}` })
      currentInventory = inventory(row)
      expect((await registry.list(input())).statuses[0]).toMatchObject({ state: 'ready' })
    }
    const refusedRevision = `sha256-${'a'.repeat(64)}`
    writeFileSync(join(files.packageDirectory, 'dist', 'index.js'), 'export const value = "refused"\n')
    row = installed({ directory: files.packageDirectory, integrity: refusedRevision })
    currentInventory = inventory(row)
    expect((await registry.list(input())).statuses[0]).toMatchObject({
      state: 'blocked',
      reason: 'snapshot-retention-limit',
    })
    expect(existsSync(join(files.snapshots, 'acme', 'panel', refusedRevision))).toBe(false)
    registry.close()
  })

  it('actively expires retained snapshots and reports resources without another client read', async () => {
    const files = fixture()
    let row = installed({ directory: files.packageDirectory })
    let currentInventory = inventory(row)
    const events: string[] = []
    const registry = createClientModuleRegistry({
      snapshotDirectory: () => files.snapshots,
      retentionMs: 20,
      changed: (event) => events.push(event.reason),
    })
    const input = () => ({
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: currentInventory,
      actual: async () => undefined,
      refreshInventory: async () => currentInventory,
    })
    await registry.list(input())
    writeFileSync(join(files.packageDirectory, 'dist', 'index.js'), 'export const value = "v2"\n')
    row = installed({ directory: files.packageDirectory, integrity: `sha256-${'2'.repeat(64)}` })
    currentInventory = inventory(row)
    await registry.list(input())
    events.length = 0
    // The expiry timer fires after the 20 ms retention, then rewrites the snapshot state on disk
    // before it reports; on a loaded runner that can take longer than any fixed sleep. The state
    // file is written before the event, so it is final once the event has arrived.
    await vi.waitFor(() => expect(events).toContain('resources'), { timeout: 5_000 })
    const state = JSON.parse(readFileSync(join(files.snapshots, '_client-modules.json'), 'utf8')) as {
      packages: Record<string, { retained: unknown[] }>
    }
    expect(state.packages['acme/panel']?.retained).toEqual([])
    registry.close()
  })

  it('revokes snapshots immediately when disabled and blocks publication above quota', async () => {
    const files = fixture()
    let row = installed({ directory: files.packageDirectory })
    let currentInventory = inventory(row)
    const events: string[] = []
    const registry = createClientModuleRegistry({
      snapshotDirectory: () => files.snapshots,
      quotaBytes: 1,
      changed: (event) => events.push(event.reason),
    })
    const input = () => ({
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: currentInventory,
      actual: async () => undefined,
      refreshInventory: async () => currentInventory,
    })
    expect((await registry.list(input())).statuses[0]).toMatchObject({
      state: 'blocked',
      reason: 'snapshot-quota-exceeded',
    })
    events.length = 0
    await registry.refresh(input(), 'inventory', row.id)
    expect(events).toEqual(['resources'])

    const serving = createClientModuleRegistry({ snapshotDirectory: () => files.snapshots })
    const ready = await serving.list(input())
    row = installed({ directory: files.packageDirectory, enabled: false })
    currentInventory = inventory(row)
    expect(await serving.list(input())).toMatchObject({ modules: [], statuses: [] })
    const readyModule = ready.modules[0]
    if (!readyModule) throw new Error('missing ready client module')
    expect(await serving.read({ ...input(), path: readyModule.entryUrl })).toEqual({ found: false })
    registry.close()
    serving.close()
  })

  it('rejects corrupt persisted identities without deleting outside the snapshot root', async () => {
    const files = fixture()
    const revision = `sha256-${'1'.repeat(64)}`
    const outside = join(files.root, 'outside', revision)
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    mkdirSync(files.snapshots, { recursive: true })
    writeFileSync(
      join(files.snapshots, '_client-modules.json'),
      JSON.stringify({
        version: 1,
        profile: 'local-dev',
        packages: { '../../outside': { current: revision, retained: [] } },
      }),
    )
    const registry = createClientModuleRegistry({ snapshotDirectory: () => files.snapshots })
    await registry.list({
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: { profile: 'local-dev', hash: 'empty', packages: [] },
      actual: async () => undefined,
      refreshInventory: async () => ({ profile: 'local-dev', hash: 'empty', packages: [] }),
    })
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
    registry.close()
  })

  it('fails closed when the install identity changes during snapshot copy', async () => {
    const files = fixture()
    const row = installed({ directory: files.packageDirectory })
    const changed = installed({
      directory: files.packageDirectory,
      integrity: `sha256-${'9'.repeat(64)}`,
    })
    const registry = createClientModuleRegistry({ snapshotDirectory: () => files.snapshots })
    const result = await registry.list({
      profile: 'local-dev',
      profileDirectory: files.root,
      inventory: inventory(row),
      actual: async () => undefined,
      refreshInventory: async () => inventory(changed),
    })
    expect(result.modules).toEqual([])
    expect(result.statuses[0]).toMatchObject({ state: 'blocked', reason: 'resources-invalid' })
    registry.close()
  })

  it('serves list/read through the shared PackageAdmin RPC handler', async () => {
    const files = fixture()
    const row = installed({
      directory: files.packageDirectory,
      publicConfig: { label: 'Public panel' },
      services: ['panel.search'],
      backend: true,
    })
    let currentInventory = inventory(row)
    const registry = createClientModuleRegistry({ snapshotDirectory: () => files.snapshots })
    const serviceDispatch = async (input: {
      packageId: string
      extension: string
      service: string
      sessionId: string
      input: Record<string, unknown>
    }) => ({ output: { ...input, privateCredentialNeverExposed: true } })
    const effectDispatch = vi.fn(async (input: Record<string, unknown>) => ({ output: input }))
    const service = createPackageAdminService({
      manager: { inventory: async () => currentInventory } as unknown as PackageManager,
      profileDirectory: async (profile) => {
        if (profile !== 'local-dev') throw new Error('profile mismatch')
        return files.root
      },
      operations: new FilePackageOperationStore(join(files.root, 'operations')),
      clientModules: registry,
      activation: { actual: async () => running(row.entry.integrity) } as never,
      clientServiceCall: serviceDispatch as never,
      clientEffectCall: effectDispatch as never,
    })
    const authority = {
      audience: 'admin' as const,
      principalId: 'test',
      clientId: 'test',
      permissions: ['packages.read' as const],
    }
    const listed = (await service.call(
      '_agnes/v1/clientModules.list',
      { profile: 'local-dev' },
      authority,
    )) as {
      modules: { entryUrl: string; publicConfig?: unknown }[]
      rows: Array<{
        rowId: string
        moduleName: string
        enabled: boolean
        phase: string
        publicConfig?: unknown
        services?: string[]
        credentialRef?: unknown
      }>
    }
    expect(listed.modules).toHaveLength(1)
    expect(listed.rows).toMatchObject([
      {
        rowId: `web:${row.id}`,
        moduleName: row.id,
        enabled: true,
        phase: 'ready',
        publicConfig: { label: 'Public panel' },
        services: ['panel.search'],
      },
    ])
    expect(listed.modules[0]).toMatchObject({ publicConfig: { label: 'Public panel' } })
    expect(listed.rows[0]).not.toHaveProperty('config')
    expect(listed.rows[0]).not.toHaveProperty('credentialRef')
    const entryUrl = listed.modules[0]?.entryUrl
    if (!entryUrl) throw new Error('missing RPC module entry URL')
    expect(
      await service.call('_agnes/v1/clientModules.read', { profile: 'local-dev', path: entryUrl }, authority),
    ).toMatchObject({ found: true })
    expect(
      await service.call(
        '_agnes/v1/clientModules.read',
        {
          profile: 'local-dev',
          path: entryUrl.replace(`${row.entry.integrity}/`, `${row.entry.integrity}0/`),
        },
        authority,
      ),
    ).toEqual({ found: false })
    await expect(
      service.call(
        '_agnes/v1/clientModules.callService',
        {
          profile: 'local-dev',
          rowId: `web:${row.id}`,
          sessionId: 'session-a',
          service: 'panel.search',
          input: { text: 'hello' },
        },
        authority,
      ),
    ).resolves.toMatchObject({
      output: {
        packageId: row.id,
        extension: row.id,
        service: 'panel.search',
        sessionId: 'session-a',
        input: { text: 'hello' },
      },
    })
    await expect(
      service.call(
        '_agnes/v1/clientModules.callEffect',
        {
          profile: 'local-dev',
          rowId: `web:${row.id}`,
          sessionId: 'session-a',
          service: 'panel.search',
          commandId: 'effect-1',
          input: { text: 'write' },
        },
        { ...authority, permissions: ['packages.read', 'extensions.execute'] },
      ),
    ).resolves.toMatchObject({ output: { commandId: 'effect-1', packageId: row.id } })
    expect(effectDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ packageId: row.id, extension: row.id, commandId: 'effect-1' }),
      expect.objectContaining({ principalId: 'test', clientId: 'test' }),
    )
    currentInventory = inventory(
      installed({
        directory: files.packageDirectory,
        trusted: false,
        services: ['panel.search'],
        backend: true,
      }),
    )
    await expect(
      service.call(
        '_agnes/v1/clientModules.callService',
        {
          profile: 'local-dev',
          rowId: `web:${row.id}`,
          sessionId: 'session-a',
          service: 'panel.search',
          input: {},
        },
        authority,
      ),
    ).rejects.toMatchObject({ message: 'CAPABILITY_DENIED' })
    await expect(
      service.call(
        '_agnes/v1/clientModules.callEffect',
        {
          profile: 'local-dev',
          rowId: `web:${row.id}`,
          sessionId: 'session-a',
          service: 'panel.search',
          commandId: 'effect-after-untrust',
          input: {},
        },
        { ...authority, permissions: ['packages.read', 'extensions.execute'] },
      ),
    ).rejects.toMatchObject({ message: 'CAPABILITY_DENIED' })
    expect(effectDispatch).toHaveBeenCalledTimes(1)
    service.closeClientModules()
  })

  it('refuses callService/callEffect with E_PACKAGE_INTEGRITY once a corrupt operations journal has put the service into recovery, like clientModules.list', async () => {
    const files = fixture()
    const row = installed({
      directory: files.packageDirectory,
      services: ['panel.search'],
      backend: true,
    })
    const operationsDir = join(files.root, 'operations')
    mkdirSync(operationsDir, { recursive: true })
    // Same fault-injection technique as package-admin-control-plane.test.ts's "contains a corrupt
    // operation journal ..." test: an unparsable operations.json forces recoverPending() to throw
    // during boot, setting `this.recoveryError`.
    writeFileSync(join(operationsDir, 'operations.json'), '{ definitely-not-json')
    const registry = createClientModuleRegistry({ snapshotDirectory: () => files.snapshots })
    const serviceDispatch = vi.fn(async () => ({ output: { ok: true } }))
    const effectDispatch = vi.fn(async () => ({ output: { ok: true } }))
    const service = createPackageAdminService({
      manager: { inventory: async () => inventory(row) } as unknown as PackageManager,
      profileDirectory: async (profile) => {
        if (profile !== 'local-dev') throw new Error('profile mismatch')
        return files.root
      },
      operations: new FilePackageOperationStore(operationsDir),
      clientModules: registry,
      activation: { actual: async () => running(row.entry.integrity) } as never,
      clientServiceCall: serviceDispatch as never,
      clientEffectCall: effectDispatch as never,
    })
    const authority = {
      audience: 'admin' as const,
      principalId: 'test',
      clientId: 'test',
      permissions: ['packages.read' as const, 'extensions.execute' as const],
    }
    // Contract reference point: clientModules.list already refuses this way.
    await expect(
      service.call('_agnes/v1/clientModules.list', { profile: 'local-dev' }, authority),
    ).rejects.toMatchObject({ data: { reason: 'E_PACKAGE_INTEGRITY' } })
    // callService/callEffect rebuild the identical roster via clientModules.list(...) before
    // dispatching into extension backend code, so they must refuse the same way -- before ever
    // reaching the backend dispatch.
    await expect(
      service.call(
        '_agnes/v1/clientModules.callService',
        {
          profile: 'local-dev',
          rowId: `web:${row.id}`,
          sessionId: 'session-a',
          service: 'panel.search',
          input: {},
        },
        authority,
      ),
    ).rejects.toMatchObject({ data: { reason: 'E_PACKAGE_INTEGRITY' } })
    await expect(
      service.call(
        '_agnes/v1/clientModules.callEffect',
        {
          profile: 'local-dev',
          rowId: `web:${row.id}`,
          sessionId: 'session-a',
          service: 'panel.search',
          commandId: 'effect-1',
          input: {},
        },
        authority,
      ),
    ).rejects.toMatchObject({ data: { reason: 'E_PACKAGE_INTEGRITY' } })
    expect(serviceDispatch).not.toHaveBeenCalled()
    expect(effectDispatch).not.toHaveBeenCalled()
    service.closeClientModules()
  })
})
