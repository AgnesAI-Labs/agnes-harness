import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResolvedPackage } from '@agnes/host-common/profile/types'
import {
  bundledPluginSource,
  HOST_CAPABILITY_GRANTS,
  type HostGrantDeclaration,
  hashDirectory,
  parseSource,
  type RuntimePluginSnapshot,
} from '@agnes/package-manager'
import type { RowOrigin } from '@agnes/plugin-runtime/host'
import { afterEach, expect, it } from 'vitest'
import * as authority from '../src/assemble/host-grants.js'

const ref = 'file:./bundled-plugins/jev-loop'
const release = bundledPluginSource(ref)!
const directory = join(release.root, release.path)
const digest = hashDirectory(directory)
const rowId = 'ext:agnes.jev/loop'
const origin: RowOrigin = {
  trustTier: 'third-party',
  packageId: '@agnes/jev-loop',
  snapshotId: digest,
  rowRevision: 'row:1',
  rowId,
  exportName: 'jevLoopPlugin',
  declaredProvides: [],
}
const pkg: ResolvedPackage = {
  id: origin.packageId,
  version: '0.1.2',
  source: ref,
  integrity: digest,
  trust: 'trusted',
  enabled: true,
}
const source: RuntimePluginSnapshot = {
  trusted: true,
  enabled: true,
  generation: 1,
  snapshot: {
    packageId: pkg.id,
    source: parseSource(ref),
    snapshotId: digest,
    version: pkg.version,
    integrity: digest,
    treeIntegrity: digest,
    profile: 'test',
    capabilityHash: 'test',
    directory,
    contributions: [],
  },
}
const declarations: readonly HostGrantDeclaration[] = [
  {
    packageId: pkg.id,
    package: {},
    extensions: { [rowId]: { sideCall: true, hookTimeoutMs: 15000 } },
    seams: {},
  },
]
const temporary: string[] = []
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})
const pin = (p = pkg, s = source, d = declarations, releaseSource = bundledPluginSource) =>
  authority.pinOptionalBundledRowGrants([p], () => s, d, releaseSource)

it('grants a matching real optional bundled source under an explicit release declaration', () => {
  expect(pin()(origin)).toEqual({ sideCall: true, hookTimeoutMs: 15000 })
  expect(pin(pkg, source, [])(origin)).toEqual({})
})
it('grants nothing when the digest differs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-grant-tree-'))
  temporary.push(dir)
  cpSync(directory, dir, { recursive: true })
  writeFileSync(join(dir, 'changed.txt'), 'changed')
  expect(
    pin(pkg, {
      ...source,
      snapshot: { ...source.snapshot, directory: dir, treeIntegrity: hashDirectory(dir) },
    })(origin),
  ).toEqual({})
})
it.each(['npm:@agnes/jev-loop', 'file:./other', 'git:https://example.invalid/jev'])(
  'rejects another source %s',
  (source) => {
    expect(pin({ ...pkg, source })(origin)).toEqual({})
  },
)
it.each([
  { rowId: 'ext:unknown/main' },
  { exportName: 'unknown' },
  { snapshotId: 'other' },
  { packageId: '@other/package' },
])('rejects mismatched row identity %j', (change) => {
  expect(pin()({ ...origin, ...change })).toEqual({})
})
it('rejects disabled, untrusted and mismatched current identities', () => {
  expect(pin({ ...pkg, enabled: false })(origin)).toEqual({})
  expect(pin(pkg, { ...source, trusted: false })(origin)).toEqual({})
  expect(pin(pkg, { ...source, enabled: false })(origin)).toEqual({})
  expect(pin({ ...pkg, integrity: 'sha256-other' })(origin)).toEqual({})
  expect(pin({ ...pkg, version: '9.0.0' })(origin)).toEqual({})
})
it('rejects a judgment identity backed by a different package snapshot', () => {
  expect(
    pin({ ...pkg, id: '@agnes/judgment', source: 'file:./bundled-plugins/judgment' })({
      ...origin,
      packageId: '@agnes/judgment',
      rowId: 'ext:agnes.judgment/main',
      exportName: 'judgmentPlugin',
    }),
  ).toEqual({})
})
it('rejects missing release source and present corrupt digest manifests', () => {
  const root = mkdtempSync(join(tmpdir(), 'agh-release-proof-'))
  temporary.push(root)
  expect(pin(pkg, source, declarations, () => ({ root, path: 'missing' }))(origin)).toEqual({})
  mkdirSync(join(root, 'payload'))
  cpSync(directory, join(root, 'payload'), { recursive: true })
  writeFileSync(join(root, 'bundled-plugin-digests.json'), 'invalid')
  expect(pin(pkg, source, declarations, () => ({ root, path: 'payload' }))(origin)).toEqual({})
  writeFileSync(join(root, 'bundled-plugin-digests.json'), '{}')
  expect(pin(pkg, source, declarations, () => ({ root, path: 'payload' }))(origin)).toEqual({})
})
it('rejects isolated exports even with a release declaration and matching source', () => {
  const root = mkdtempSync(join(tmpdir(), 'agh-isolated-proof-'))
  temporary.push(root)
  cpSync(directory, join(root, 'payload'), { recursive: true })
  const file = join(root, 'payload', 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.agnes.plugins[0].runtime = 'isolated'
  writeFileSync(file, JSON.stringify(manifest))
  const changed = hashDirectory(join(root, 'payload'))
  const snapshot = {
    ...source,
    snapshot: {
      ...source.snapshot,
      directory: join(root, 'payload'),
      snapshotId: changed,
      integrity: changed,
      treeIntegrity: changed,
    },
  }
  expect(
    pin({ ...pkg, integrity: changed }, snapshot, declarations, () => ({ root, path: 'payload' }))({
      ...origin,
      snapshotId: changed,
    }),
  ).toEqual({})
})
it('revalidates refreshed wrappers without dropping the same verified identity', () => {
  let current = source
  const grant = authority.pinOptionalBundledRowGrants([pkg], () => current, declarations)
  expect(grant(origin)).toEqual({ sideCall: true, hookTimeoutMs: 15000 })
  current = { ...source, snapshot: { ...source.snapshot } }
  expect(grant(origin)).toEqual({ sideCall: true, hookTimeoutMs: 15000 })
})

it('admits the real optional judgment release only with its matching source digest and row', () => {
  const released = bundledPluginSource('file:./bundled-plugins/judgment')
  expect(released).toBeDefined()
  const directory = join(released!.root, released!.path)
  const digest = hashDirectory(directory)
  const pkg = {
    id: '@agnes/judgment',
    version: '0.1.0',
    source: 'file:./bundled-plugins/judgment',
    integrity: digest,
    trust: 'trusted' as const,
    enabled: true,
  }
  const current = {
    ...source,
    snapshot: {
      ...source.snapshot,
      packageId: pkg.id,
      source: parseSource(pkg.source),
      version: pkg.version,
      snapshotId: digest,
      integrity: digest,
      treeIntegrity: digest,
      directory,
    },
  }
  const row = {
    ...origin,
    packageId: pkg.id,
    snapshotId: digest,
    rowId: 'ext:agnes.judgment/main',
    exportName: 'judgmentPlugin',
  }
  const grant = authority.pinOptionalBundledRowGrants([pkg], () => current, HOST_CAPABILITY_GRANTS)
  expect(grant(row)).toEqual({ sideCall: true, sessionWork: true, autoTitle: true, hookTimeoutMs: 15000 })
  expect(grant({ ...row, exportName: 'other' })).toEqual({})
  expect(grant({ ...row, snapshotId: 'changed' })).toEqual({})
})

it.each([
  undefined,
  { type: 'file', ref: 'file:./other' },
  { type: 'npm', ref },
  { type: 'file', ref, extra: true },
])('rejects absent, mismatched or noncanonical snapshot provenance %j', (provenance) => {
  const { source: _provenance, ...snapshot } = source.snapshot
  const current = { ...source, snapshot }
  if (provenance !== undefined) Object.assign(snapshot, { source: provenance })
  expect(pin(pkg, current)(origin)).toEqual({})
})
it('does not replace an established identity when both current package and snapshot change', () => {
  const currentPackage = { ...pkg }
  let current = structuredClone(source)
  const grant = authority.pinOptionalBundledRowGrants([currentPackage], () => current, declarations)
  expect(grant(origin)).toEqual({ sideCall: true, hookTimeoutMs: 15000 })
  currentPackage.version = '0.1.3'
  current = { ...current, snapshot: { ...current.snapshot, version: '0.1.3', snapshotId: 'new-snapshot' } }
  expect(grant({ ...origin, snapshotId: 'new-snapshot' })).toEqual({})
})
it('binds only after full proof and rechecks a refreshed directory and row', () => {
  const root = mkdtempSync(join(tmpdir(), 'agh-grant-refresh-'))
  temporary.push(root)
  let current = { ...source, snapshot: { ...source.snapshot, directory: join(root, 'missing') } }
  const grant = authority.pinOptionalBundledRowGrants([pkg], () => current, declarations)
  expect(grant(origin)).toEqual({})
  current = { ...source, snapshot: { ...source.snapshot } }
  expect(grant(origin)).toEqual({ sideCall: true, hookTimeoutMs: 15000 })
  cpSync(directory, join(root, 'copy'), { recursive: true })
  current = { ...source, snapshot: { ...source.snapshot, directory: join(root, 'copy') } }
  expect(grant(origin)).toEqual({ sideCall: true, hookTimeoutMs: 15000 })
  writeFileSync(join(root, 'copy', 'index.mjs'), 'changed')
  current = { ...current, snapshot: { ...current.snapshot } }
  expect(grant(origin)).toEqual({})
})
it('rejects a changed capability identity after a successful proof', () => {
  let current = source
  const grant = authority.pinOptionalBundledRowGrants([pkg], () => current, declarations)
  expect(grant(origin)).toEqual({ sideCall: true, hookTimeoutMs: 15000 })
  current = { ...source, snapshot: { ...source.snapshot, capabilityHash: 'other' } }
  expect(grant(origin)).toEqual({})
})
