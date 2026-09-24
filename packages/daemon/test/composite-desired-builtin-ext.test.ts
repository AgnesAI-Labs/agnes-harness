import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InstalledInventory, InstalledPackage } from '@agnes/package-manager'
import { decodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { afterEach, describe, expect, it } from 'vitest'
import { rebuildDesiredFromInventory } from '../src/composite-desired.js'

const PACKAGE_ID = '@acme/widgets'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function thirdPartyPackage(manifest: { plugins: readonly Record<string, unknown>[] }): InstalledPackage {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-desired-builtin-ext-'))
  dirs.push(directory)
  writeFileSync(
    join(directory, 'package.json'),
    `${JSON.stringify({ name: PACKAGE_ID, version: '1.0.0', agnes: { plugins: manifest.plugins } })}\n`,
  )
  return {
    id: PACKAGE_ID,
    directory,
    entry: {
      version: '1.0.0',
      integrity: `sha256-${'b'.repeat(64)}`,
      source: { kind: 'path', ref: directory },
    } as unknown as InstalledPackage['entry'],
    capabilityHash: 'capability',
    trusted: true,
    enabled: true,
    contributions: [],
    blockers: [],
    verifiedRollbackTarget: null,
  }
}

function rowsFor(pkg: InstalledPackage) {
  const inventory: InstalledInventory = { profile: 'local-dev', hash: 'hash', packages: [pkg] }
  const next = rebuildDesiredFromInventory({
    previous: undefined,
    inventory,
    packageId: pkg.id,
    operation: 'enable',
  })
  if (!next) throw new Error('enable must produce a desired artifact')
  return decodeRuntimeTargetArtifact(next).tree.rows
}

describe('rebuildDesiredFromInventory ext: ids', () => {
  it('keeps a third-party row that replaces a builtin ext: id', () => {
    // The builtin extension rows are replaceable: a package that declares `ext:agnes/tools-core`
    // supplies that row instead of the Host's own.
    const rows = rowsFor(thirdPartyPackage({ plugins: [{ export: 'x', id: 'ext:agnes/tools-core' }] }))
    expect(rows.map((r) => r.id)).toEqual(['ext:agnes/tools-core'])
    expect(rows[0]?.plugin).toMatch(/^@acme\/widgets@.+\/x$/u)
  })

  it('keeps an ordinary third-party row whose default id happens to start with ext:', () => {
    // `ext:<pkg>/<export>` is the DEFAULT id of every agnes.plugins entry
    // (packages/package-manager/src/plugin-manifest.ts:72), so the gate must key on the `agnes/`
    // scope, never on the `ext:` prefix alone.
    const rows = rowsFor(thirdPartyPackage({ plugins: [{ export: 'x' }] }))
    expect(rows.map((r) => r.id)).toEqual(['ext:@acme/widgets/x'])
  })
})

describe('rebuildDesiredFromInventory service metadata', () => {
  // The daemon never imports the module, so the row's provides/inject can only come from the manifest
  // declaration. Without them the worker refuses the mount: E_ROW_METADATA when the export declares
  // `provide`, E_PROVIDE_DENIED when it does not (measured on a real daemon).
  it('builds the row with the provide and inject names the manifest declares', () => {
    const rows = rowsFor(
      thirdPartyPackage({
        plugins: [{ export: 'x', provide: ['acmeStats'], inject: ['clock', 'acmeBase'] }],
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.provides).toEqual(['acmeStats'])
    expect(rows[0]?.inject).toEqual(['acmeBase', 'clock'])
  })

  it('builds an empty-metadata row when the manifest declares nothing', () => {
    const rows = rowsFor(thirdPartyPackage({ plugins: [{ export: 'x' }] }))
    expect(rows[0]?.provides).toEqual([])
    expect(rows[0]?.inject).toEqual([])
  })

  it('changes the row identity when a declared name changes, so a stale row cannot be reused', () => {
    const before = rowsFor(thirdPartyPackage({ plugins: [{ export: 'x', provide: ['a'] }] }))[0]
    const after = rowsFor(thirdPartyPackage({ plugins: [{ export: 'x', provide: ['b'] }] }))[0]
    expect(before?.mountIdentity).not.toEqual(after?.mountIdentity)
  })
})
