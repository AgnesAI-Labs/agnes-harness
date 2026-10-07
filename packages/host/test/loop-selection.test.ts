import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LOOP } from '@agnes/core'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { afterEach, expect, it } from 'vitest'
import * as dagModule from '../../../examples/loops/dag-loop/index.mjs'
import { readAdminLoopDefault } from '../src/assemble/loop-selection.js'
import { createConfigurationService } from '../src/configuration.js'
import { scaffold } from '../../../templates/create-agh-plugin.mjs'
import { createLoader } from '../src/ext-host/loader.js'
import { createTestHost } from '../testkit/index.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const dag = { id: 'example.dag', version: '1.0.0' }

async function fixture(profileLoop = true, template = false) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-loops-'))
  dirs.push(dataDir)
  const directory = join(dataDir, 'snapshot')
  const loopSelection = template ? { id: 'tiny-loop', version: '0.1.0' } : dag
  if (template) await scaffold('loop', 'tiny-loop', directory, { local: true })
  else
    cpSync(fileURLToPath(new URL('../../../examples/loops/dag-loop', import.meta.url)), directory, {
      recursive: true,
      filter: (path) => !path.includes('/node_modules'),
    })
  const manifest = JSON.parse(
    await import('node:fs/promises').then((fs) => fs.readFile(join(directory, 'package.json'), 'utf8')),
  )
  manifest.agnes.plugins[0].config = { plan: [] }
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest))
  const source: RuntimePluginSnapshot = {
    snapshot: {
      packageId: template ? 'tiny-loop' : '@agnes-example/dag-loop',
      version: loopSelection.version,
      snapshotId: `sha256-${'1'.repeat(64)}`,
      integrity: `sha256-${'2'.repeat(64)}`,
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: 'fixture',
      directory,
      profile: 'local-dev',
      contributions: [],
    },
    generation: 1,
    trusted: true,
  }
  const { host, profile } = await createTestHost({
    dataDir,
    packageDirs: { [source.snapshot.packageId]: directory },
    script: template
      ? [
          [
            { type: 'text_delta', delta: 'Demo reply' },
            { type: 'done', reason: 'stop' },
          ],
        ]
      : [],
    disableSessionTitle: true,
    lock: {
      packages: Object.fromEntries(
        ['@agnes/ai', '@agnes/base', '@agnes/code', source.snapshot.packageId].map((id) => [
          id,
          {
            version: '1.0.0',
            integrity: source.snapshot.integrity,
            trust: id === source.snapshot.packageId ? 'trusted' : 'builtin',
            enabled: true,
          },
        ]),
      ),
    },
    profileInputs: {
      user: {
        name: 'local-dev',
        packages: [{ id: source.snapshot.packageId, source: `file:${directory}` }],
        ...(profileLoop ? { loop: loopSelection } : {}),
      },
    },
    runtimePluginSnapshots: [source],
    runtimePluginCatalogue: [source],
    runtimePluginSources: async () => [source],
    extensionLoader: template
      ? createLoader({ cacheDir: join(dataDir, 'cache'), hostRoot: dataDir, agnesVersion: '0.0.0' })
      : {
          import: async (file) => {
            expect(file.endsWith('/snapshot/index.mjs')).toBe(true)
            return dagModule
          },
        },
  })
  const profileDir = join(dataDir, 'profiles', 'local-dev')
  const defaults = (loop: typeof dag) => {
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(
      join(profileDir, 'configuration.json'),
      JSON.stringify({
        version: 2,
        profile: 'local-dev',
        revision: 1,
        accounts: [],
        defaultAccountId: null,
        inheritProvider: true,
        sessionDefaults: { loop },
      }),
    )
  }
  return { dataDir, profileDir, host, profile, defaults }
}

it('loads an installed manifest plugin before Kernel construction, selects profile/admin/explicit defaults and keeps the persisted identity', async () => {
  const f = await fixture()
  try {
    expect(f.profile.loop).toEqual(dag)
    expect(Object.isFrozen(f.profile.loop)).toBe(true)
    expect(f.host.kernel.loops.catalog()).toContainEqual({
      ...dag,
      sourcePackage: '@agnes-example/dag-loop',
      capabilities: ['tools', 'parallel', 'checkpoint', 'model'],
    })
    const profileSession = await f.host.createSession({
      key: 'profile-loop',
      cwd: f.dataDir,
      writerRunId: 'profile-writer',
    })
    expect(profileSession.loop).toEqual(dag)
    await profileSession.enqueue('next-turn', {
      content: [{ type: 'text', text: 'static DAG' }],
      actor: profileSession.d.actor,
    })
    expect(
      await profileSession.run({ until: 'turn-end', signal: new AbortController().signal }),
    ).toMatchObject({ reason: 'completed' })
    expect(await profileSession.scan({ type: 'x/dag/result', limit: 1 })).toHaveLength(1)
    expect(await profileSession.scan({ type: 'effect/intent', limit: 1 })).toEqual([])
    await createConfigurationService({ home: f.dataDir, profile: 'local-dev' }).saveSessionDefaults({
      revision: 0,
      defaults: { loop: DEFAULT_LOOP },
    })
    const adminSession = await f.host.createSession({ key: 'admin-loop', cwd: f.dataDir })
    expect(adminSession.loop).toEqual(DEFAULT_LOOP)
    const explicitSession = await f.host.createSession({ key: 'explicit-loop', cwd: f.dataDir, loop: dag })
    expect(explicitSession.loop).toEqual(dag)
    await profileSession.close()
    f.defaults({ id: '', version: '1' }) // Existing ledger identity bypasses changed defaults.
    const resumed = await f.host.createSession({
      key: 'profile-loop',
      cwd: f.dataDir,
      writerRunId: 'profile-writer',
    })
    expect(resumed.loop).toEqual(dag)
    await expect(
      f.host.createSession({ key: 'unknown-loop', cwd: f.dataDir, loop: { id: 'missing', version: '1' } }),
    ).rejects.toMatchObject({ code: 'E_LOOP_MISSING' })
    expect(f.host.kernel.get('unknown-loop')).toBeUndefined()
  } finally {
    await f.host.close()
  }
})

it('uses the built-in loop without a default and refuses an invalid persisted default', async () => {
  const f = await fixture(false)
  try {
    expect((await f.host.createSession({ key: 'builtin', cwd: f.dataDir })).loop).toEqual(DEFAULT_LOOP)
    f.defaults({ id: '', version: '1' })
    await expect(f.host.createSession({ key: 'invalid-default', cwd: f.dataDir })).rejects.toMatchObject({
      code: 'E_PRESET_UNSUPPORTED',
    })
    expect(
      await readAdminLoopDefault(
        createConfigurationService({ home: join(f.dataDir, 'absent'), profile: 'local-dev' }),
      ),
    ).toBeUndefined()
    const customConfiguration = createConfigurationService({
      home: f.dataDir,
      profile: 'local-dev',
      profileDir: join(f.dataDir, 'custom-profile'),
    })
    await customConfiguration.saveSessionDefaults({ revision: 0, defaults: { loop: dag } })
    expect(await readAdminLoopDefault(customConfiguration)).toEqual(dag)
    f.defaults({ id: 'missing', version: '1' })
    await expect(f.host.createSession({ key: 'missing-default', cwd: f.dataDir })).rejects.toMatchObject({
      code: 'E_LOOP_MISSING',
    })
    // Explicit selection wins even when the saved default is not installed.
    expect((await f.host.createSession({ key: 'override', cwd: f.dataDir, loop: dag })).loop).toEqual(dag)
  } finally {
    await f.host.close()
  }
})

it('activates the zero-build loop template from an installed snapshot without SDK dependencies', async () => {
  const f = await fixture(true, true)
  try {
    // Host exposes this same kernel catalog to the admin loops API.
    expect(f.host.kernel.loops.catalog()).toContainEqual({
      id: 'tiny-loop',
      version: '0.1.0',
      sourcePackage: 'tiny-loop',
      capabilities: ['model'],
    })
    const session = await f.host.createSession({ key: 'template-loop', cwd: f.dataDir })
    expect(session.loop).toEqual({ id: 'tiny-loop', version: '0.1.0' })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor: session.d.actor })
    const result = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(result.reason, JSON.stringify(result)).toBe('completed')
    const reply = await session.scan({ type: 'assistant/message', limit: 1 })
    expect(reply[0]?.data).toMatchObject({ content: [{ type: 'text', text: 'Demo reply' }] })
  } finally {
    await f.host.close()
  }
})
