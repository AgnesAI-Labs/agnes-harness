import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LOOP, resetChildAgentAllowlists } from '@agnes/core'
import {
  type ChildAgentPluginContext,
  type ChildAgentProvider,
  type ChildAgentService,
  type ChildAgentStartOptions,
  type LoopContext,
  type LoopFactory,
  type LoopPluginContext,
  loopCheckpointCodec,
  registerLoopPlugin,
} from '@agnes/extension-api'
import { buildCompleteRuntimeTarget } from '@agnes/host'
import { parsePackageBundles } from '@agnes/host-common/profile/composition'
import { createLoader } from '@agnes/host-extensions/ext-host/loader'
import { createConfigurationService } from '@agnes/host-infrastructure/configuration'
import { readAdminLoopDefault } from '@agnes/host-providers/assemble/loop-selection'
import { developmentPluginRows, hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { afterEach, expect, it } from 'vitest'
import * as dagModule from '../../../examples/loops/dag-loop/index.mjs'
import { scaffold } from '../../../templates/create-agh-plugin.mjs'
import { createTestHost } from '../testkit/index.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const dag = { id: 'example.dag', version: '1.0.0' }

async function fixture(
  profileLoop = true,
  template = false,
  childModule?: Record<string, unknown>,
  bundle = false,
  installedAfterBoot = false,
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-loops-'))
  dirs.push(dataDir)
  const directory = join(dataDir, 'snapshot')
  const loopSelection = childModule
    ? { id: 'test.children', version: '1.0.0' }
    : template
      ? { id: 'tiny-loop', version: '0.1.0' }
      : dag
  if (childModule) {
    mkdirSync(directory)
    writeFileSync(join(directory, 'index.mjs'), 'export const main = {}')
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'acme/child-loop',
        version: '1.0.0',
        main: './index.mjs',
        agnes: {
          plugins: [
            {
              export: 'main',
              id: 'loop:children',
              apiRange: '^1.4.0',
              inject: ['loops', 'childAgents'],
              runtime: 'in-process',
            },
          ],
        },
      }),
    )
  } else if (template) await scaffold('loop', 'tiny-loop', directory, { local: true })
  else
    cpSync(fileURLToPath(new URL('../../../examples/loops/dag-loop', import.meta.url)), directory, {
      recursive: true,
      filter: (path) => !path.includes('/node_modules'),
    })
  const manifest = JSON.parse(
    await import('node:fs/promises').then((fs) => fs.readFile(join(directory, 'package.json'), 'utf8')),
  )
  manifest.agnes.plugins[0].config = { plan: [] }
  if (installedAfterBoot) manifest.agnes.plugins[0].default = false
  if (bundle) manifest.agnes.bundles = { selected: { profile: { loop: loopSelection } } }
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest))
  const source: RuntimePluginSnapshot = {
    snapshot: {
      packageId: childModule ? 'acme/child-loop' : template ? 'tiny-loop' : '@agnes-example/dag-loop',
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
    packageDirs: installedAfterBoot ? {} : { [source.snapshot.packageId]: directory },
    script: template
      ? [
          [
            { type: 'text_delta', delta: 'Demo reply' },
            { type: 'done', reason: 'stop' },
          ],
        ]
      : [],
    disableSessionTitle: true,
    ...(childModule ? { treeBudgetCredits: 2 } : {}),
    lock: {
      packages: Object.fromEntries(
        [
          '@agnes/ai',
          '@agnes/base',
          '@agnes/code',
          ...(installedAfterBoot ? [] : [source.snapshot.packageId]),
        ].map((id) => [
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
      ...(bundle && !installedAfterBoot
        ? {
            bundleCatalog: parsePackageBundles(source.snapshot.packageId, {
              selected: { profile: { loop: loopSelection } },
            }),
          }
        : {}),
      user: {
        name: 'local-dev',
        ...(bundle ? { composition: {} } : {}),
        packages: installedAfterBoot
          ? []
          : [
              {
                id: source.snapshot.packageId,
                source: `file:${directory}`,
                ...(childModule ? { config: { 'child-agent': { provider: 'public-fixture' } } } : {}),
              },
            ],
        ...(profileLoop ? { loop: loopSelection } : {}),
      },
    },
    runtimePluginSnapshots: installedAfterBoot ? [] : [source],
    runtimePluginCatalogue: installedAfterBoot ? [] : [source],
    runtimePluginSources: async () => [source],
    extensionLoader: template
      ? createLoader({ cacheDir: join(dataDir, 'cache'), hostRoot: dataDir, agnesVersion: '0.0.0' })
      : {
          import: async (file) => {
            expect(file.endsWith('/snapshot/index.mjs')).toBe(true)
            return childModule ?? dagModule
          },
        },
  })
  if (installedAfterBoot) {
    const current = host.runtimeTargetSnapshot!()
    await host.applyRuntimeTarget(
      buildCompleteRuntimeTarget({
        rows: [
          ...current.tree.rows.filter((row) => !row.plugin.startsWith('builtin:')),
          ...developmentPluginRows(source, []).map((row) => Object.freeze({ ...row, disabled: false })),
        ],
        resources: current.resource.resources,
      }).target,
    )
  }
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
    f.defaults({ id: 'missing', version: '1' }) // Existing ledger identity bypasses changed defaults.
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
    await expect(
      createTestHost({
        dataDir: join(f.dataDir, 'missing-provider'),
        script: [],
        profileInputs: { user: { name: 'local-dev', loop: { id: 'missing', version: '1.0.0' } } },
      }),
    ).rejects.toMatchObject({ code: 'E_SEAM_INIT', detail: { reason: 'provider-unknown' } })
    f.defaults({ id: '', version: '1' })
    await expect(f.host.createSession({ key: 'invalid-default', cwd: f.dataDir })).rejects.toMatchObject({
      code: 'CONFIG_INVALID_STATE',
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

it('binds a third-party loop to configured, parent-owned continuable children with budget and generation inheritance', async () => {
  let registry: ChildAgentService | undefined
  const contexts = new Map<string, LoopContext>()
  const received: ChildAgentStartOptions[] = []
  const children = new Map<string, { parent: string; messages: string[]; interrupted: boolean }>()
  const disposed: string[] = []
  let releaseStart!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseStart = resolve
  })
  let markStarting!: () => void
  const starting = new Promise<void>((resolve) => {
    markStarting = resolve
  })
  const provider: ChildAgentProvider = {
    id: 'public-fixture',
    version: '1.0.0',
    capabilities: {
      continuable: true,
      interrupt: true,
      modelSelection: true,
      inheritsParentContext: true,
      worktree: false,
      budget: true,
      toolFilter: true,
    },
    async start(task, options) {
      received.push(options)
      if (task === 'late child') {
        markStarting()
        await gate
      }
      const id = 'child-' + received.length
      const child = { parent: options.sessionKey, messages: [task], interrupted: false }
      children.set(id, child)
      return {
        id,
        providerId: 'public-fixture',
        capabilities: this.capabilities,
        sendMessage: async (text) => {
          child.messages.push(text)
          return { messageId: id + '-next' }
        },
        interrupt: async () => {
          child.interrupted = true
          return { accepted: true }
        },
        result: async () => ({ status: 'interrupted', text: child.messages.join('|') }),
        async *events() {
          yield { type: 'status', status: 'interrupted' }
        },
        async dispose() {
          disposed.push(id)
          await contexts.get(child.parent)?.events.emit('x/child/disposed', { id })
          children.delete(id)
        },
      }
    },
    async list(parent) {
      return [...children]
        .filter(([, child]) => child.parent === parent)
        .map(([id, child]) => ({
          id,
          providerId: 'public-fixture',
          status: child.interrupted ? 'interrupted' : 'idle',
          continuable: true,
        }))
    },
  }
  const codec = loopCheckpointCodec(1, (state) => {
    if (state !== null) throw new Error('Unsupported child loop checkpoint')
    return null
  })
  const loop: LoopFactory = {
    id: 'test.children',
    version: '1.0.0',
    capabilities: ['children'],
    codec,
    create(ctx) {
      contexts.set(ctx.sessionKey, ctx)
      return {
        checkpoint: () => codec.encode(null),
        cancel() {},
        dispose() {},
        async step(signal) {
          if (!(await ctx.input.claim('next-turn'))) return { outcome: 'idle' }
          const port = ctx.children
          if (!port) throw new Error('Missing public child port')
          try {
            await port.start('denied', { model: 'blocked' })
          } catch (error) {
            await ctx.events.emit('x/child/refused', { message: String(error) })
          }
          const handle = await port.start('start', {
            model: 'fast',
            budget: 99,
            signal,
            sessionKey: 'forged-parent',
            generation: 'forged-generation',
          } as never)
          await handle.sendMessage('continue', signal)
          await handle.interrupt()
          const result = await port.result(handle.id)
          const events = []
          for await (const event of port.events(handle.id)) events.push(event)
          await ctx.events.emit('x/child/result', { id: handle.id, result, events })
          await ctx.events.finish('completed')
          return { outcome: 'turn-ended', reason: 'completed' }
        },
      }
    },
    resume(ctx, checkpoint) {
      codec.decode(checkpoint)
      return this.create(ctx)
    },
  }
  const f = await fixture(true, false, {
    main: {
      inject: ['loops', 'childAgents'],
      apply(ctx: LoopPluginContext & ChildAgentPluginContext) {
        registry = ctx.childAgents
        registerLoopPlugin(ctx, 'acme/child-loop', loop)
        ctx.childAgents.register(provider)
        for (const key of ['loop-parent', 'other-parent'])
          ctx.childAgents.setSessionAllowlist(key, { providers: ['public-fixture'], models: ['fast'] })
      },
    },
  })
  try {
    const parent = await f.host.createSession({ key: 'loop-parent', cwd: f.dataDir })
    const other = await f.host.createSession({ key: 'other-parent', cwd: f.dataDir })
    for (const session of [parent, other]) {
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: 'children' }],
        actor: session.d.actor,
        budget: 1,
      })
      expect(await session.run({ until: 'turn-end', signal: new AbortController().signal })).toMatchObject({
        reason: 'completed',
      })
      expect((await session.scan({ type: 'x/child/refused', limit: 1 }))[0]?.data).toMatchObject({
        message: expect.stringContaining('E_MODEL_UNKNOWN'),
      })
    }
    expect(received).toHaveLength(2)
    expect(received[0]).toMatchObject({
      sessionKey: parent.key,
      cwd: parent.d.cwd,
      generation: f.host.sessionGeneration?.(parent.key),
      model: 'fast',
      budget: 1,
    })
    expect(received[0]?.generation).toBeTruthy()
    expect(received[1]).toMatchObject({
      sessionKey: other.key,
      generation: f.host.sessionGeneration?.(other.key),
    })
    expect(children.get('child-1')).toMatchObject({ messages: ['start', 'continue'], interrupted: true })
    expect((await parent.scan({ type: 'x/child/result', limit: 1 }))[0]?.data).toMatchObject({
      id: 'child-1',
      result: { status: 'interrupted', text: 'start|continue' },
      events: [{ type: 'status', status: 'interrupted' }],
    })
    const own = contexts.get(parent.key)?.children
    const foreign = contexts.get(other.key)?.children
    expect(await own?.list()).toEqual([expect.objectContaining({ id: 'child-1' })])
    await expect(foreign?.sendMessage('child-1', 'intrude')).rejects.toThrow('not owned')
    registry?.setSessionAllowlist(parent.key, { providers: [] })
    await expect(own?.start('allowlist changed', { model: 'fast' })).rejects.toThrow('E_UNSUPPORTED')
    expect(received).toHaveLength(2)
    const closing = parent.close()
    await Promise.all([closing, parent.close()])
    expect(disposed).toEqual(['child-1'])
    expect(
      (await f.host.kernel.o.storage.scan(parent.key, { type: 'x/child/disposed', limit: 10 })).map(
        (row) => row.data,
      ),
    ).toEqual([{ id: 'child-1' }])
    await expect(own?.start('after close', { model: 'fast' })).rejects.toMatchObject({ code: 'E_CLOSED' })
    expect(await foreign?.list()).toEqual([expect.objectContaining({ id: 'child-2' })])
    const pending = foreign?.start('late child', { model: 'fast' })
    const refused = expect(pending).rejects.toThrow()
    await starting
    let joined = false
    const otherClose = other.close().then(() => {
      joined = true
    })
    await expect.poll(() => received[2]?.signal.aborted).toBe(true)
    expect(joined).toBe(false)
    releaseStart()
    await refused
    await otherClose
    expect(disposed.sort()).toEqual(['child-1', 'child-2', 'child-3'])
  } finally {
    releaseStart()
    await f.host.close()
    resetChildAgentAllowlists()
  }
})

it.each([false, true])(
  'lets explicit session bundles override the administrative Loop default (installed after boot: %s)',
  async (installedAfterBoot) => {
    const f = await fixture(false, false, undefined, true, installedAfterBoot)
    try {
      await createConfigurationService({ home: f.dataDir, profile: 'local-dev' }).saveSessionDefaults({
        revision: 0,
        defaults: { loop: DEFAULT_LOOP },
      })
      const session = await f.host.createSession({
        key: 'bundle-loop',
        cwd: f.dataDir,
        bundles: ['@agnes-example/dag-loop#selected'],
      })
      expect(session.loop).toEqual(dag)
      expect(f.host.sessionCapabilities!(session.key)).toMatchObject({
        loop: { value: dag },
        bundles: ['@agnes-example/dag-loop#selected'],
      })
      await session.close()
    } finally {
      await f.host.close()
    }
  },
)
