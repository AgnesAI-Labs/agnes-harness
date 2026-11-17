import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionContext, PluginContextFacets } from '@agnes/extension-api'
import {
  bundledPluginSource,
  type HostCapabilityGrant,
  hashDirectory,
  parseSource,
  type RuntimePluginSnapshot,
} from '@agnes/package-manager'
import { createPluginRow, type RowOrigin } from '@agnes/plugin-runtime/host'
import { afterEach, expect, it, vi } from 'vitest'
import { hostInspectionSource } from '../../src/runtime/lifecycle/host-facade.js'
import { createTestHost } from '../../testkit/index.js'
import { settle, targetOf } from './plugin-extension-fixture.js'

// Every grant authority an assembly pins, and what it returned to each row that asked.
const seen = vi.hoisted(() => ({
  authorities: [] as ((origin: Readonly<RowOrigin>) => HostCapabilityGrant)[],
  asked: [] as { origin: Readonly<RowOrigin>; grant: HostCapabilityGrant }[],
}))
vi.mock('@agnes/host-extensions/assemble/host-grants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agnes/host-extensions/assemble/host-grants')>()
  return {
    ...actual,
    pinOptionalBundledRowGrants: (...args: Parameters<typeof actual.pinOptionalBundledRowGrants>) => {
      const authority = actual.pinOptionalBundledRowGrants(...args)
      seen.authorities.push(authority)
      return (origin: Readonly<RowOrigin>) => {
        const grant = authority(origin)
        seen.asked.push({ origin, grant })
        return grant
      }
    },
  }
})

const REF = 'file:./bundled-plugins/judgment'
const ROW = 'ext:agnes.judgment/main'
const EXPORT = 'judgmentPlugin'
const GRANTED = { sideCall: true, sessionWork: true, autoTitle: true, hookTimeoutMs: 15000 }
const release = bundledPluginSource(REF)!
const shipped = join(release.root, release.path)
const manifest = JSON.parse(readFileSync(join(shipped, 'package.json'), 'utf8'))
const entry = manifest.agnes.plugins.find((plugin: { id: string }) => plugin.id === ROW)
const builtins = Object.fromEntries(
  ['@agnes/ai', '@agnes/base', '@agnes/code'].map((id) => [
    id,
    {
      version: '0.1.0',
      source: { type: 'builtin' as const, ref: 'builtin' },
      integrity: 'builtin:0.1.0',
      trust: 'builtin' as const,
      enabled: true,
    },
  ]),
)
const roots: string[] = []
afterEach(() => {
  seen.authorities.length = 0
  seen.asked.length = 0
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), 'agh-optional-grants-'))
  roots.push(root)
  return root
}

/** The shipped judgment payload, or a copy of it with one extra file (another digest). */
function judgment(directory = shipped, enabled = true): RuntimePluginSnapshot {
  const digest = hashDirectory(directory)
  return {
    snapshot: {
      packageId: manifest.name,
      version: manifest.version,
      profile: 'local-dev',
      source: parseSource(REF),
      snapshotId: digest,
      integrity: digest,
      treeIntegrity: digest,
      capabilityHash: 'fixture',
      directory,
      contributions: [],
    },
    generation: 1,
    trusted: true,
    enabled,
  }
}
function changedCopy(): string {
  const directory = join(scratch(), 'judgment')
  cpSync(shipped, directory, {
    recursive: true,
    filter: (path) => !path.includes('node_modules') && !path.includes(`${shipped}/test`),
  })
  writeFileSync(join(directory, 'changed.txt'), 'not the shipped payload')
  return directory
}
const judgmentRow = (source: RuntimePluginSnapshot) =>
  createPluginRow({
    id: ROW,
    plugin: `${manifest.name}@${source.snapshot.snapshotId}/${EXPORT}`,
    snapshotDigest: source.snapshot.integrity,
    exportName: EXPORT,
    entryRevision: source.snapshot.snapshotId,
    extrasRevision: 'none',
    mountRevision: 'host-ordinary-row:v1',
    inject: entry.inject,
  })

async function bootWithoutJudgment(boot: 'absent' | 'disabled') {
  let sources: RuntimePluginSnapshot[] = boot === 'disabled' ? [judgment(shipped, false)] : []
  const selves: ExtensionContext[] = []
  const sessionWork: (true | string)[] = []
  const root = scratch()
  const h = await createTestHost({
    dataDir: root,
    packageDirs: {
      '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)),
      '@agnes/code': fileURLToPath(new URL('../../../code', import.meta.url)),
    },
    lock: {
      packages: {
        ...builtins,
        // Installed and reviewed, but not enabled when this Host booted.
        ...(boot === 'disabled'
          ? {
              [manifest.name]: {
                version: manifest.version,
                source: parseSource(REF),
                integrity: judgment().snapshot.integrity,
                trust: 'trusted' as const,
                enabled: false,
              },
            }
          : {}),
      },
    },
    profileInputs: { user: { name: 'local-dev', composition: {} } },
    runtimePluginSources: async () => sources,
    extensionLoader: {
      import: async () => ({
        [EXPORT]: {
          inject: entry.inject,
          apply(plugin: PluginContextFacets) {
            selves.push(plugin.self)
            try {
              plugin.sessionWork?.register({ name: 'grant.probe', observe() {}, async run() {} })
              sessionWork.push(true)
            } catch (error) {
              sessionWork.push(error instanceof Error ? error.message : String(error))
            }
          },
        },
      }),
    },
  })
  return {
    host: h.host,
    root,
    selves,
    sessionWork,
    setSources(next: RuntimePluginSnapshot[]) {
      sources = next
    },
  }
}

/** What the judgment row was granted the last time it asked, and what each authority grants it now. */
function judgmentGrants() {
  const asked = seen.asked.filter(({ origin }) => origin.rowId === ROW)
  const last = asked.at(-1)
  return {
    mounted: last?.grant,
    now: last ? seen.authorities.map((authority) => authority(last.origin)) : [],
  }
}

it.each([
  { boot: 'absent', bound: false },
  { boot: 'disabled', bound: false },
  { boot: 'absent', bound: true },
] as const)(
  'grants judgment enabled after boot exactly as a fresh container would, and drops it when disabled ($boot, bound: $bound)',
  async ({ boot, bound }) => {
    const f = await bootWithoutJudgment(boot)
    try {
      expect(judgmentGrants().mounted).toBeUndefined()
      const container = hostInspectionSource(f.host)
      const session = bound ? await f.host.createSession({ key: 'bound', cwd: f.root }) : undefined
      const enabled = judgment()
      f.setSources([enabled])
      expect(await f.host.applyRuntimeTarget(targetOf([judgmentRow(enabled)]))).toMatchObject({ ok: true })
      await settle()
      // Unbound, the package is mounted in place in the boot container; bound, the change forks.
      expect(hostInspectionSource(f.host) === container).toBe(!bound)
      expect(judgmentGrants().mounted).toEqual(GRANTED)
      expect(f.selves.at(-1)?.sideModels).toBeDefined()
      expect(f.sessionWork.at(-1)).toBe(true)

      // Turned off: no published generation selects it any more, although its snapshot is still
      // installed and trusted. Every container's authority refuses it.
      expect(await f.host.applyRuntimeTarget(targetOf([]))).toMatchObject({ ok: true })
      await settle()
      expect(judgmentGrants().now.length).toBeGreaterThan(0)
      for (const grant of judgmentGrants().now) expect(grant).toEqual({})
      // Disabled in the package manager as well: its source is no longer enabled.
      f.setSources([judgment(shipped, false)])
      expect(await f.host.applyRuntimeTarget(targetOf([]))).toMatchObject({ ok: true })
      for (const grant of judgmentGrants().now) expect(grant).toEqual({})
      await session?.close()
    } finally {
      await f.host.close()
    }
  },
  30000,
)

it('grants nothing to a changed judgment payload and grants the shipped one it is updated to in place', async () => {
  const f = await bootWithoutJudgment('absent')
  try {
    const changed = judgment(changedCopy())
    f.setSources([changed])
    expect(await f.host.applyRuntimeTarget(targetOf([judgmentRow(changed)]))).toMatchObject({ ok: true })
    await settle()
    expect(judgmentGrants().mounted).toEqual({})
    expect(f.selves.at(-1)?.sideModels).toBeUndefined()

    const container = hostInspectionSource(f.host)
    const updated = judgment()
    f.setSources([updated])
    expect(await f.host.applyRuntimeTarget(targetOf([judgmentRow(updated)]))).toMatchObject({ ok: true })
    await settle()
    expect(hostInspectionSource(f.host) === container).toBe(true)
    expect(judgmentGrants().mounted).toEqual(GRANTED)
    // The authority still refuses the changed snapshot, another export and another row.
    const { origin } = seen.asked.filter((item) => item.origin.rowId === ROW).at(-1)!
    for (const authority of seen.authorities) {
      expect(authority({ ...origin, snapshotId: changed.snapshot.snapshotId })).toEqual({})
      expect(authority({ ...origin, exportName: 'other' })).toEqual({})
      expect(authority({ ...origin, rowId: 'ext:agnes.judgment/other' })).toEqual({})
    }
  } finally {
    await f.host.close()
  }
}, 30000)
