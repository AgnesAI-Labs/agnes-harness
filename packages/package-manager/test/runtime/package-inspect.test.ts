import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { jcs } from '@agnes/protocol'
import type { RuntimeWireTypes as Wire } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type AcquiredPackage,
  checkPackageBuildExecution,
  inspectLockedPackage,
  type SourceBuildDeclaration,
} from '../../src/runtime/package-inspect.js'
import { digestJson, identifyPackage, readPackageTree, sha256Hex } from '../../src/runtime/source-snapshot.js'

// The acceptance fixture is outside this package's compilation root; load its test-only module.
const fixtureUrl = new URL('../../../../tools/acceptance/runtime/fixtures/broken-plugin.ts', import.meta.url)
type Mode =
  | 'normal'
  | 'malicious-manifest'
  | 'outside-path'
  | 'symlink'
  | 'case-conflict'
  | 'omitted-files'
  | 'entry-missing'
  | 'npm-integrity'
  | 'git-commit'
  | 'required-ui'
  | 'download-cancelled'
  | 'unapproved-build'
  | 'secret-build'
interface Fixture {
  lock: Wire['PackageLockEntry']
  locator: Wire['PackageLocator']
  archive: Buffer
  files: readonly { path: string; bytes: Buffer }[]
  build?: SourceBuildDeclaration
  requiredUi: readonly { target: 'web' }[]
  cancelDownload: boolean
}
const fixtures = (await import(fixtureUrl.href)) as {
  createBrokenPlugin: (mode?: Mode, kind?: 'local' | 'npm' | 'git') => Fixture
  writeBrokenPlugin: (root: string, fixture: Fixture) => void
}
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const temporary = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'agh-inspect-'))
  roots.push(root)
  return root
}
const inspect = (fixture: Fixture) =>
  inspectLockedPackage({
    lock: fixture.lock,
    requiredUi: fixture.requiredUi,
    acquire: async () => ({
      ok: true,
      value: {
        locator: fixture.locator,
        content: { archive: fixture.archive },
        ...(fixture.build ? { build: fixture.build } : {}),
      },
    }),
  })

describe('immutable runtime package inspection', () => {
  it.each(['local', 'npm', 'git'] as const)(
    'checks a locked %s package without executing entries or lifecycle scripts',
    async (kind) => {
      const fixture = fixtures.createBrokenPlugin('normal', kind)
      const result = await inspect(fixture)
      expect(result).toMatchObject({
        ok: true,
        value: {
          packageDigest: fixture.lock.digest,
          productionDependencies: [],
          buildPlan: { status: 'no-build', steps: [] },
        },
      })
      if (!result.ok) throw new Error(result.detailCode)
      expect(result.value.manifestDigest).toBe(
        fixture.lock.manifestRef.kind === 'inline' ? fixture.lock.manifestRef.digest : '',
      )
      expect(result.value.archiveIntegrity).toBe(
        fixture.locator.kind === 'npm' ? fixture.locator.integrity : `sha256-${sha256Hex(fixture.archive)}`,
      )
      expect(
        new Set([result.value.packageDigest, result.value.manifestDigest, result.value.archiveIntegrity])
          .size,
      ).toBe(3)
    },
  )

  it.each([
    ['malicious-manifest', 'local', 'manifest_invalid'],
    ['outside-path', 'local', 'path_escape'],
    ['symlink', 'local', 'symlink_escape'],
    ['case-conflict', 'local', 'case_conflict'],
    ['omitted-files', 'local', 'file_unlisted'],
    ['entry-missing', 'local', 'entry_missing'],
    ['npm-integrity', 'npm', 'archive_integrity_mismatch'],
    ['git-commit', 'git', 'source_identity_mismatch'],
    ['required-ui', 'local', 'required_ui_missing'],
  ] as const)('refuses %s explicitly', async (mode, kind, detailCode) => {
    expect(await inspect(fixtures.createBrokenPlugin(mode, kind))).toMatchObject({
      ok: false,
      code: 'denied',
      detailCode,
    })
  })

  it.each(['npm', 'git'] as const)('refuses an unresolved %s alias before acquisition', async (kind) => {
    const fixture = fixtures.createBrokenPlugin('normal', kind)
    const locator =
      fixture.locator.kind === 'git'
        ? { ...fixture.locator, commit: 'main' }
        : fixture.locator.kind === 'npm'
          ? { ...fixture.locator, version: 'latest' }
          : fixture.locator
    expect(
      await inspectLockedPackage({
        lock: { ...fixture.lock, locator },
        acquire: async () => {
          throw new Error('unlocked source must not be acquired')
        },
      }),
    ).toMatchObject({
      ok: false,
      detailCode: kind === 'git' ? 'git_commit_unlocked' : 'npm_version_unlocked',
    })
  })

  it('reads a local directory through the same digest gate and rejects an external symlink', async () => {
    const fixture = fixtures.createBrokenPlugin(),
      root = temporary()
    fixtures.writeBrokenPlugin(root, fixture)
    const input = {
      lock: fixture.lock,
      acquire: async () => ({ ok: true as const, value: { locator: fixture.locator, content: { root } } }),
    }
    expect(await inspectLockedPackage(input)).toMatchObject({ ok: true })
    rmSync(join(root, 'runtime/index.js'))
    const external = join(temporary(), 'outside.js')
    writeFileSync(external, 'external')
    symlinkSync(external, join(root, 'runtime/index.js'), 'file')
    expect(await inspectLockedPackage(input)).toMatchObject({ ok: false, detailCode: 'symlink_escape' })
  })

  it('cancels before acquisition and during the download without inspecting partial bytes', async () => {
    const fixture = fixtures.createBrokenPlugin('download-cancelled'),
      controller = new AbortController()
    const input = {
      lock: fixture.lock,
      signal: controller.signal,
      acquire: async () => {
        expect(fixture.cancelDownload).toBe(true)
        controller.abort()
        return {
          ok: true as const,
          value: { locator: fixture.locator, content: { archive: Buffer.from('partial') } },
        }
      },
    }
    expect(await inspectLockedPackage(input)).toMatchObject({
      ok: false,
      code: 'cancelled',
      detailCode: 'download_cancelled',
    })
    expect(
      await inspectLockedPackage({
        ...input,
        acquire: async () => {
          throw new Error('must not acquire')
        },
      }),
    ).toMatchObject({ ok: false, detailCode: 'download_cancelled' })
    const pendingController = new AbortController()
    let complete: ((value: { ok: true; value: AcquiredPackage }) => void) | undefined
    const pending = inspectLockedPackage({
      lock: fixture.lock,
      signal: pendingController.signal,
      acquire: () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    })
    pendingController.abort()
    expect(await pending).toMatchObject({ ok: false, detailCode: 'download_cancelled' })
    complete?.({ ok: true, value: { locator: fixture.locator, content: { archive: fixture.archive } } })
  })

  it.each(['unapproved-build', 'secret-build'] as const)('plans %s but denies execution', async (mode) => {
    const fixture = fixtures.createBrokenPlugin(mode),
      result = await inspect(fixture)
    expect(result).toMatchObject({
      ok: true,
      value: { buildPlan: { status: 'approval-required', steps: [fixture.build] } },
    })
    if (!result.ok) throw new Error(result.detailCode)
    const plan = result.value.buildPlan
    expect(checkPackageBuildExecution(plan, null)).toMatchObject({
      ok: false,
      detailCode: mode === 'secret-build' ? 'secret_consumer_unavailable' : 'build_unapproved',
    })
    expect(checkPackageBuildExecution(plan, plan.digest)).toMatchObject({
      ok: false,
      detailCode: mode === 'secret-build' ? 'secret_consumer_unavailable' : 'sandbox_unavailable',
    })
    expect(checkPackageBuildExecution({ ...plan, steps: [] }, plan.digest)).toMatchObject({
      ok: false,
      detailCode: 'build_plan_changed',
    })
  })

  it.each([
    [
      'file_digest_mismatch',
      (manifest: Record<string, unknown>) => {
        const rows = manifest.files as { digest: string }[]
        if (rows[0]) rows[0].digest = 'f'.repeat(64)
      },
    ],
    ['manifest_digest_mismatch', (_manifest: Record<string, unknown>) => {}],
    [
      'dev_dependency_in_runtime',
      (manifest: Record<string, unknown>) => {
        manifest.dependencies = [
          { packageId: 'fixture-dev-only', versionRange: '^1.0.0', kind: 'runtime', optional: false },
        ]
      },
    ],
    [
      'reproducibility_unverified',
      (manifest: Record<string, unknown>) => {
        ;(manifest.build as { reproducible: boolean }).reproducible = true
      },
    ],
    [
      'manifest_invalid',
      (manifest: Record<string, unknown>) => {
        Object.assign(manifest.build as object, { script: 'exit 93' })
      },
    ],
  ] as const)('rejects fabricated content or metadata: %s', async (detailCode, mutate) => {
    const fixture = fixtures.createBrokenPlugin(),
      root = temporary()
    fixtures.writeBrokenPlugin(root, fixture)
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as Record<string, unknown>
    mutate(manifest)
    writeFileSync(join(root, 'manifest.json'), jcs(manifest))
    const lock =
      detailCode === 'manifest_digest_mismatch' && fixture.lock.manifestRef.kind === 'inline'
        ? { ...fixture.lock, manifestRef: { ...fixture.lock.manifestRef, digest: 'f'.repeat(64) } }
        : fixture.lock
    expect(
      await inspectLockedPackage({
        lock,
        acquire: async () => ({
          ok: true,
          value: {
            locator: fixture.locator,
            content: { root },
          },
        }),
      }),
    ).toMatchObject({ ok: false, detailCode })
  })

  it('verifies the static UI example using contract self-digest zeroing, without bypassing the source reader', async () => {
    const root = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../examples/packages/runtime-ui-bundle/v1',
    )
    const tree = readPackageTree(root)
    if (!tree.ok) throw new Error(tree.detailCode)
    const manifest = JSON.parse(
      readFileSync(join(root, 'manifest.json'), 'utf8'),
    ) as Wire['RuntimePluginManifest']
    const locator: Wire['PackageLocator'] = {
      kind: 'local',
      sourceId: 'fixture.ui',
      pathRef: 'fixture.ui',
      digest: manifest.packageDigest,
    }
    const text = jcs(manifest)
    const lock: Wire['PackageLockEntry'] = {
      packageId: manifest.id,
      version: manifest.version,
      digest: manifest.packageDigest,
      locator,
      dependencies: [],
      manifestRef: {
        kind: 'inline',
        schema: { typeId: 'agh.package/manifest@1', revision: 1, digest: sha256Hex('manifest') },
        value: manifest,
        digest: digestJson(manifest),
        bytes: Buffer.byteLength(text),
      },
    }
    const acquired: AcquiredPackage = { locator, content: { root } }
    expect(
      await inspectLockedPackage({
        lock,
        acquire: async () => ({ ok: true, value: acquired }),
        requiredUi: [{ target: 'web', rendererId: 'example.runtime-ui-bundle/status-card.web' }],
      }),
    ).toMatchObject({ ok: true, value: { packageDigest: manifest.packageDigest } })
    const oldReader = identifyPackage(tree.value)
    expect(oldReader.ok && oldReader.value.treeDigest).not.toBe(manifest.packageDigest)
    const changedRoot = temporary()
    fixtures.writeBrokenPlugin(changedRoot, { ...fixtures.createBrokenPlugin(), files: tree.value })
    const renderer = manifest.renderers[0]
    if (!renderer) throw new Error('missing example renderer')
    renderer.packageDigest = '0'.repeat(64)
    writeFileSync(join(changedRoot, 'manifest.json'), jcs(manifest))
    expect(
      await inspectLockedPackage({
        lock,
        acquire: async () => ({
          ok: true,
          value: {
            locator,
            content: { root: changedRoot },
          },
        }),
      }),
    ).toMatchObject({ ok: false, detailCode: 'self_digest_mismatch' })
  })
})
