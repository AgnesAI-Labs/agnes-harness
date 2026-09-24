import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InstalledInventory, InstalledPackage } from '@agnes/package-manager'
import {
  buildRuntimeTarget,
  createPluginRow,
  decodeRuntimeTargetArtifact,
  encodeRuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clientModuleRowId,
  clientModuleRowIdForContribution,
  rebuildDesiredFromInventory,
  reconcileDesiredWebRows,
} from '../src/composite-desired.js'

const revision = 'a'.repeat(64)
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function installed(
  over: Partial<InstalledPackage> & Pick<InstalledPackage, 'id' | 'directory'>,
): InstalledPackage {
  return {
    entry: {
      version: '1.0.0',
      integrity: `sha256-${'b'.repeat(64)}`,
      source: { kind: 'path', ref: over.directory as string },
      ...(over.entry ?? {}),
    } as InstalledPackage['entry'],
    capabilityHash: 'capability',
    trusted: true,
    enabled: true,
    contributions: [],
    blockers: [],
    verifiedRollbackTarget: null,
    ...over,
  }
}

function inventory(packages: readonly InstalledPackage[]): InstalledInventory {
  return { profile: 'local-dev', hash: 'hash', packages }
}

function clientContribution(id = 'acme/panel', clientId?: string) {
  return {
    kind: 'extension' as const,
    id,
    path: './extension.js',
    apiRange: '*',
    capabilities: {},
    client: { entry: './client.js', ...(clientId === undefined ? {} : { id: clientId }) },
  }
}

function previous(id: string, packageId = 'acme/echo') {
  return encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows: [
        createPluginRow({
          id,
          plugin: `${packageId}@sha256-${'b'.repeat(64)}/echo`,
          snapshotDigest: `sha256-${'b'.repeat(64)}`,
          exportName: 'echo',
          entryRevision: `sha256-${'b'.repeat(64)}`,
          extrasRevision: 'none',
          mountRevision: 'host-ordinary-row:v1',
        }),
      ],
      resources: { mcp: [], skills: {} },
      resourceRevision: revision,
      compositeRevision: revision,
    }),
  )
}

describe('rebuildDesiredFromInventory', () => {
  it('bounds multi-client row identity without truncating either author identifier', () => {
    const packageId = `acme/${'p'.repeat(230)}`
    const extensionId = `acme/${'e'.repeat(230)}`
    const rowId = clientModuleRowId(packageId, extensionId, 2)
    expect(rowId).toMatch(/^web:[a-f0-9]{64}$/)
    expect(rowId).toHaveLength(68)
    expect(clientModuleRowId(packageId, extensionId, 2)).toBe(rowId)
  })

  it('uses an explicit client contribution id for stable multi-client row identity', () => {
    expect(clientModuleRowIdForContribution('acme/panel', 'acme/primary', 2, 'stable-primary')).toBe(
      'web:acme/panel:stable-primary',
    )
  })

  it('adds ordinary rows from the installed package on enable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agnes-desired-enable-'))
    dirs.push(directory)
    writeFileSync(
      join(directory, 'package.json'),
      `${JSON.stringify({
        name: 'acme/echo',
        version: '1.0.0',
        agnes: { plugins: [{ export: 'echo', id: 'ext:acme/echo', runtime: 'in-process', default: true }] },
      })}\n`,
    )
    const next = rebuildDesiredFromInventory({
      previous: undefined,
      inventory: inventory([installed({ id: 'acme/echo', directory })]),
      packageId: 'acme/echo',
      operation: 'enable',
    })
    expect(next).toBeDefined()
    expect(next?.digest).not.toBe(previous('ext:acme/echo').digest)
  })

  it('does not create a browser row for a skin-only descriptor', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agnes-desired-skin-only-'))
    dirs.push(directory)
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'acme/skin',
        version: '1.0.0',
        agnes: { plugins: [{ export: 'skin', id: 'ext:acme/skin', runtime: 'in-process' }] },
      }),
    )
    const next = rebuildDesiredFromInventory({
      previous: undefined,
      inventory: inventory([
        installed({
          id: 'acme/skin',
          directory,
          contributions: [
            {
              kind: 'client',
              id: 'plugin/0123456789abcdef',
              rowId: 'ext:acme/skin',
              path: './skin/agnes.client.json',
              skins: [{ id: 'paper', name: 'Paper', css: './paper.css' }],
            },
          ],
        }),
      ]),
      packageId: 'acme/skin',
      operation: 'enable',
    })
    if (!next) throw new Error('missing skin-only desired target')
    expect(decodeRuntimeTargetArtifact(next).tree.rows.map((row) => row.id)).toEqual(['ext:acme/skin'])
  })

  it('enable of an extension-only package still returns a complete desired digest', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agnes-desired-extension-'))
    dirs.push(directory)
    writeFileSync(
      join(directory, 'package.json'),
      `${JSON.stringify({
        name: '@agnes-examples/hot-tool',
        version: '1.0.0',
        agnes: { extensions: ['./extensions/main'] },
      })}\n`,
    )
    const next = rebuildDesiredFromInventory({
      previous: undefined,
      inventory: inventory([installed({ id: '@agnes-examples/hot-tool', directory })]),
      packageId: '@agnes-examples/hot-tool',
      operation: 'enable',
    })
    expect(next?.digest).toMatch(/^sha256-[0-9a-f]{64}$/)
  })

  it('mints one daemon-owned web row for one client contribution with its own mount revision', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agnes-desired-client-'))
    dirs.push(directory)
    const next = rebuildDesiredFromInventory({
      previous: undefined,
      inventory: inventory([
        installed({ id: 'acme/panel', directory, contributions: [clientContribution()] }),
      ]),
      packageId: 'acme/panel',
      operation: 'enable',
    })
    const rows = decodeRuntimeTargetArtifact(next as NonNullable<typeof next>).tree.rows
    expect(rows).toContainEqual(
      expect.objectContaining({
        id: 'web:acme/panel',
        plugin: expect.stringContaining('@sha256-'),
        mountRevision: 'host-web-row:v1',
      }),
    )
    expect(rows.find((row) => row.id === 'web:acme/panel')?.plugin).toMatch(/\/client$/)
  })

  it('does not let agnes.plugins translate an author web row', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agnes-desired-web-claim-'))
    dirs.push(directory)
    writeFileSync(
      join(directory, 'package.json'),
      `${JSON.stringify({
        name: 'acme/claim',
        version: '1.0.0',
        agnes: { plugins: [{ export: 'claim', id: 'web:acme/claim' }] },
      })}\n`,
    )
    const next = rebuildDesiredFromInventory({
      previous: undefined,
      inventory: inventory([installed({ id: 'acme/claim', directory })]),
      packageId: 'acme/claim',
      operation: 'enable',
    })
    const rows = decodeRuntimeTargetArtifact(next as NonNullable<typeof next>).tree.rows
    expect(rows.some((row) => row.id.startsWith('web:'))).toBe(false)
  })

  it('drops an ordinary author row outside the ext namespace', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agnes-desired-non-ext-'))
    dirs.push(directory)
    writeFileSync(
      join(directory, 'package.json'),
      `${JSON.stringify({
        name: 'acme/claim',
        version: '1.0.0',
        agnes: { plugins: [{ export: 'claim', id: 'custom:acme/claim' }] },
      })}\n`,
    )
    const next = rebuildDesiredFromInventory({
      previous: undefined,
      inventory: inventory([installed({ id: 'acme/claim', directory })]),
      packageId: 'acme/claim',
      operation: 'enable',
    })
    const rows = decodeRuntimeTargetArtifact(next as NonNullable<typeof next>).tree.rows
    expect(rows).toHaveLength(0)
  })

  it('mints independent web rows when a package declares multiple client sources', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agnes-desired-duplicate-client-'))
    dirs.push(directory)
    const next = rebuildDesiredFromInventory({
      previous: undefined,
      inventory: inventory([
        installed({
          id: 'acme/panel',
          directory,
          contributions: [clientContribution('acme/panel-a'), clientContribution('acme/panel-b')],
        }),
      ]),
      packageId: 'acme/panel',
      operation: 'enable',
    })
    const rows = decodeRuntimeTargetArtifact(next as NonNullable<typeof next>).tree.rows
    expect(rows.filter((row) => row.id.startsWith('web:acme/panel:')).map((row) => row.id)).toEqual([
      'web:acme/panel:acme/panel-a',
      'web:acme/panel:acme/panel-b',
    ])
  })

  it('uses explicit client ids when minting multiple web rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agnes-desired-stable-client-'))
    dirs.push(directory)
    const next = rebuildDesiredFromInventory({
      previous: undefined,
      inventory: inventory([
        installed({
          id: 'acme/panel',
          directory,
          contributions: [
            clientContribution('acme/panel-a', 'stable-primary'),
            clientContribution('acme/panel-b', 'stable-secondary'),
          ],
        }),
      ]),
      packageId: 'acme/panel',
      operation: 'enable',
    })
    const rows = decodeRuntimeTargetArtifact(next as NonNullable<typeof next>).tree.rows
    expect(rows.filter((row) => row.id.startsWith('web:acme/panel:')).map((row) => row.id)).toEqual([
      'web:acme/panel:stable-primary',
      'web:acme/panel:stable-secondary',
    ])
  })

  it('disables the named package rows without dropping unrelated desired rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agnes-desired-disable-'))
    dirs.push(directory)
    const current = previous('ext:acme/echo')
    const next = rebuildDesiredFromInventory({
      previous: current,
      inventory: inventory([installed({ id: 'acme/echo', directory, enabled: false })]),
      packageId: 'acme/echo',
      operation: 'disable',
    })
    expect(next).toBeDefined()
    expect(next?.digest).not.toBe(current.digest)
  })

  it.each([
    ['remove', 'remove'],
    ['rollback after deletion', 'rollback'],
  ] as const)('%s cannot resurrect deleted package rows', (_label, operation) => {
    const current = previous('ext:acme/echo')
    const next = rebuildDesiredFromInventory({
      previous: current,
      inventory: inventory([]),
      packageId: 'acme/echo',
      operation,
    })
    const rows = decodeRuntimeTargetArtifact(next as NonNullable<typeof next>).tree.rows
    expect(rows).toHaveLength(0)
  })

  it('does not resurrect package rows after trust is removed during rollback', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agnes-desired-untrusted-'))
    dirs.push(directory)
    const current = previous('ext:acme/echo')
    const next = rebuildDesiredFromInventory({
      previous: current,
      inventory: inventory([installed({ id: 'acme/echo', directory, trusted: false })]),
      packageId: 'acme/echo',
      operation: 'rollback',
    })
    const rows = decodeRuntimeTargetArtifact(next as NonNullable<typeof next>).tree.rows
    expect(rows).toHaveLength(0)
  })

  it('backfills missing startup web rows while preserving disabled trusted rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agnes-desired-startup-web-'))
    dirs.push(directory)
    const packageRow = installed({ id: 'acme/panel', directory, contributions: [clientContribution()] })
    const current = rebuildDesiredFromInventory({
      previous: undefined,
      inventory: inventory([packageRow]),
      packageId: packageRow.id,
      operation: 'enable',
    })
    if (!current) throw new Error('missing current artifact')
    const ordinaryOnly = encodeRuntimeTargetArtifact(
      buildRuntimeTarget({
        rows: decodeRuntimeTargetArtifact(current).tree.rows.filter((row) => !row.id.startsWith('web:')),
        resources: { mcp: [], skills: {} },
        resourceRevision: revision,
        compositeRevision: revision,
      }),
    )
    const repaired = reconcileDesiredWebRows({ desired: ordinaryOnly, inventory: inventory([packageRow]) })
    expect(decodeRuntimeTargetArtifact(repaired as NonNullable<typeof repaired>).tree.rows).toContainEqual(
      expect.objectContaining({ id: 'web:acme/panel', disabled: false }),
    )
    const disabled = installed({
      id: packageRow.id,
      directory,
      enabled: false,
      contributions: [clientContribution()],
    })
    const preserved = reconcileDesiredWebRows({ desired: current, inventory: inventory([disabled]) })
    expect(decodeRuntimeTargetArtifact(preserved as NonNullable<typeof preserved>).tree.rows).toContainEqual(
      expect.objectContaining({ id: 'web:acme/panel' }),
    )
  })
})
