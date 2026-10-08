import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultLoopPlugin, sandboxWorkspaceProbe, toolPolicyPlugin } from '@agnes/base'
import { loadPreset } from '@agnes/code'
import { Context } from '@agnes/cordis'
import {
  LOCAL_SANDBOX_PROVIDER_ID,
  type SandboxExecutionPolicy,
  type SandboxProvider,
  sandboxUnavailable,
} from '@agnes/extension-api'
import { createExec, createPolicyExec } from '@agnes/host-infrastructure/adapters/exec'
import { createLocalSandboxProvider } from '@agnes/host-infrastructure/adapters/sandbox-local'
import { createAdminSessionSelection } from '@agnes/host-infrastructure/admin-session-selection'
import { createConfigurationService } from '@agnes/host-infrastructure/configuration'
import {
  bindStartupSandboxProvider,
  createSandboxDispatchExec,
  installSandboxProviders,
  readSandboxStartupConfig,
  type SandboxProviderSlot,
} from '@agnes/host-providers/adapters/sandbox-providers'
import type {} from '@agnes/host-providers/assemble/loops'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import { afterAll, describe, expect, it } from 'vitest'
import { createTestHost } from '../../testkit/index.js'

const cwd = mkdtempSync(join(tmpdir(), 'agnes-sandbox-provider-'))
const nodeEnv = process.env.ELECTRON_RUN_AS_NODE
  ? { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE }
  : {}

const policy: SandboxExecutionPolicy = {
  workspaceRoot: cwd,
  digest: 'a'.repeat(64),
  fsRead: { allow: ['/'], deny: [join(cwd, '.git')] },
  fsWrite: { allow: [cwd, join(cwd, 'extra')], deny: [join(cwd, '.git')] },
  network: { mode: 'deny', hosts: [] },
  requiredEnforcement: { level: 'none', scope: [] },
}
const enforcement = { level: 'none' as const, scope: [] }
const binding = { policyDigest: policy.digest, backend: 'none' as const, policy, enforcement }

afterAll(() => rmSync(cwd, { recursive: true, force: true }))

function box(id: string, available = true): SandboxProvider {
  return {
    id,
    version: '1.0.0',
    capabilities: {
      network: false,
      fsWrite: [],
      platform: ['linux'],
      available,
      ...(available ? {} : { unavailableReason: 'missing' }),
    },
    create: () => ({
      id,
      capabilities: {
        network: false,
        fsWrite: [],
        platform: ['linux'],
        available,
        ...(available ? {} : { unavailableReason: 'missing' }),
      },
      exec: async (request) => ({
        code: 0,
        stdout: request.argv.join(' '),
        stderr: '',
        truncated: false,
        timedOut: false,
        enforcement,
      }),
      dispose() {},
    }),
  }
}

describe('sandbox providers', () => {
  it('reads sandbox.provider and rejects unknown keys', () => {
    expect(readSandboxStartupConfig(undefined)).toBeUndefined()
    expect(readSandboxStartupConfig({ provider: 'docker', options: { image: 'alpine' } })).toEqual({
      provider: 'docker',
      options: { image: 'alpine' },
    })
    expect(() => readSandboxStartupConfig({ provider: 'docker', options: { image: 42 } })).toThrow(
      /mapping of strings/,
    )
    expect(() => readSandboxStartupConfig({ image: 'alpine' })).toThrow(/sandbox\.image/)
    expect(() => readSandboxStartupConfig({ provider: 'Docker' })).toThrow(/provider id/)
  })

  it('catalogs the local provider and refuses a second id until restart', async () => {
    const root = new Context()
    const registry = installSandboxProviders(root)
    registry.register(createLocalSandboxProvider(createExec(), process.platform))
    registry.register(box('box'))
    expect(registry.catalog().map((entry) => entry.id)).toEqual(['box', LOCAL_SANDBOX_PROVIDER_ID])
    expect(registry.catalog().every((entry) => entry.restartRequired)).toBe(true)
    expect(
      registry.catalog().find((entry) => entry.id === LOCAL_SANDBOX_PROVIDER_ID)?.capabilities,
    ).toMatchObject({
      network: true,
      fsWrite: [],
      available: true,
    })
    expect(() => registry.register(box('box'))).toThrow(/duplicate sandbox provider/)
    const selected = await registry.select(LOCAL_SANDBOX_PROVIDER_ID, { workspaceRoot: cwd })
    expect(selected.id).toBe(LOCAL_SANDBOX_PROVIDER_ID)
    expect(await registry.select(LOCAL_SANDBOX_PROVIDER_ID, { workspaceRoot: cwd })).toBe(selected)
    expect(await registry.select(LOCAL_SANDBOX_PROVIDER_ID, { workspaceRoot: join(cwd, 'other') })).not.toBe(
      selected,
    )
    await expect(registry.select('box')).rejects.toThrow(/requires a restart/)
    await expect(registry.select('missing')).rejects.toThrow(/requires a restart/)
  })

  it('runs a local command and stops it when the signal aborts', async () => {
    const exec = createExec({ detached: false })
    const preaborted = new AbortController()
    preaborted.abort(new Error('Stopped before create'))
    expect(() => createLocalSandboxProvider(exec, process.platform).create({}, preaborted.signal)).toThrow(
      'Stopped before create',
    )
    const instance = await createLocalSandboxProvider(exec, process.platform, { ownProcesses: true }).create(
      {},
    )
    const ok = await instance.exec({
      argv: [process.execPath, '-e', 'process.stdout.write("ok")'],
      cwd,
      policy,
      enforcement,
      env: nodeEnv,
    })
    expect(ok).toMatchObject({ code: 0, stdout: 'ok', timedOut: false })
    await expect(
      instance.exec({
        argv: [process.execPath, '-e', 'process.stdout.write("no")'],
        cwd,
        policy,
        enforcement,
        network: true,
      }),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    const signal = new AbortController()
    const pending = instance.exec({
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      cwd,
      policy,
      enforcement,
      env: nodeEnv,
      signal: signal.signal,
      limits: { timeoutMs: 10_000 },
    })
    signal.abort()
    const stopped = await pending
    expect(stopped.signal).toBe('SIGKILL')
    await instance.dispose()
  })

  it('refuses a configured provider when nothing has registered one', async () => {
    await expect(
      bindStartupSandboxProvider({}, { sandbox: { provider: 'docker' } }, cwd, false),
    ).rejects.toThrow(/not registered/)
    await expect(bindStartupSandboxProvider({}, undefined, cwd, false)).resolves.toBe(
      LOCAL_SANDBOX_PROVIDER_ID,
    )
    await expect(
      bindStartupSandboxProvider({}, { sandbox: { provider: 'docker' } }, cwd, true),
    ).rejects.toThrow(/remote workspace/)
  })

  it('does not fall back to the local spawner when the selected provider is unavailable', async () => {
    const local = createExec({ detached: false })
    let localRan = false
    const wrapped = {
      run: async (...args: Parameters<typeof local.run>) => {
        localRan = true
        return local.run(...args)
      },
      killAll: () => local.killAll(),
    }
    const slot: SandboxProviderSlot = {}
    const root = new Context()
    slot.registry = installSandboxProviders(root)
    slot.registry.register(box('box', false))
    const id = await bindStartupSandboxProvider(slot, { sandbox: { provider: 'box' } }, cwd, false)
    expect(id).toBe('box')
    const dispatch = createSandboxDispatchExec(wrapped, slot)
    await expect(dispatch.run(['echo', 'hi'], { cwd })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    await expect(
      dispatch.openProcess!(['bash'], { cwd, sandbox: binding, pty: { columns: 80, rows: 24 } }),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    expect(localRan).toBe(false)
    expect(sandboxUnavailable('missing').code).toBe('SANDBOX_UNAVAILABLE')
  })

  it('forwards authorized roots, network policy, options and enforcement through every provider entry', async () => {
    const root = new Context()
    const registry = installSandboxProviders(root)
    const seen: unknown[] = []
    let resolveExit!: (exit: { code: number }) => void
    const exited = new Promise<{ code: number }>((resolve) => {
      resolveExit = resolve
    })
    const provider = box('box')
    registry.register({
      ...provider,
      capabilities: { ...provider.capabilities, enforcement },
      create(config) {
        seen.push(config)
        return {
          ...(provider.create(config) as import('@agnes/extension-api').SandboxProviderInstance),
          capabilities: { ...provider.capabilities, enforcement },
          async openProcess(request) {
            seen.push(request)
            return {
              enforcement,
              exited,
              onOutput: () => () => {},
              write: async () => {},
              resize: async () => {},
              signal: async () => {},
              close: async () => {
                resolveExit({ code: 137 })
              },
            }
          },
          async exec(request) {
            seen.push(request)
            return { code: 0, stdout: 'provider', stderr: '', truncated: false, timedOut: false, enforcement }
          },
        }
      },
    })
    const slot: SandboxProviderSlot = { registry }
    await bindStartupSandboxProvider(
      slot,
      { sandbox: { provider: 'box', options: { image: 'test' } } },
      cwd,
      false,
    )
    const dispatch = createSandboxDispatchExec(
      {
        run: async () => {
          throw new Error('local bypass')
        },
        killAll: async () => {},
      },
      slot,
    )
    await expect(dispatch.run(['echo', 'ok'], { cwd, sandbox: binding })).resolves.toMatchObject({
      stdout: 'provider',
    })
    expect(seen[0]).toEqual({ workspaceRoot: cwd, options: { image: 'test' } })
    expect(seen[1]).toMatchObject({
      policy,
      fsWrite: policy.fsWrite.allow.map((path) => ({ path })),
      network: false,
    })
    const openNetwork = { ...policy, network: { mode: 'hosts' as const, hosts: ['example.test'] } }
    await dispatch.run(['echo', 'net'], { cwd, sandbox: { ...binding, policy: openNetwork } })
    expect(seen[2]).toMatchObject({ policy: openNetwork, network: true })
    await expect(
      dispatch.run(['echo'], {
        cwd,
        sandbox: {
          ...binding,
          policy: {
            ...policy,
            requiredEnforcement: { level: 'full', scope: ['file', 'network', 'process'] },
          },
        },
      }),
    ).rejects.toThrow(/required enforcement/)
    const aborted = new AbortController()
    aborted.abort(new Error('cancelled'))
    await expect(dispatch.run(['echo'], { cwd, signal: aborted.signal, sandbox: binding })).rejects.toThrow(
      'cancelled',
    )
    expect(seen.slice(1).map((request) => (request as { argv: string[] }).argv)).toEqual([
      ['echo', 'ok'],
      ['echo', 'net'],
    ])
    const handle = await dispatch.openProcess!(['bash', '-i'], {
      cwd,
      sandbox: binding,
      pty: { columns: 91, rows: 31 },
    })
    expect(seen[3]).toMatchObject({ policy, enforcement, pty: { columns: 91, rows: 31 } })
    await slot.selected!.dispose()
    expect(await handle.exited).toEqual({ code: 137 })
    await expect(dispatch.openProcess!(['bash'], { cwd, sandbox: binding })).rejects.toThrow(/disposed/)
  })

  it('dispatches local execution through the registered public instance', async () => {
    const calls: unknown[] = []
    const provider = createLocalSandboxProvider(
      {
        run: async (argv, options) => {
          calls.push({ argv, options })
          return { code: 0, stdout: 'local-provider', stderr: '', truncated: false, timedOut: false }
        },
        killAll: async () => {},
      },
      process.platform,
    )
    const instance = await provider.create({ workspaceRoot: cwd })
    const dispatch = createSandboxDispatchExec(
      {
        run: async () => {
          throw new Error('bypass')
        },
        killAll: async () => {},
      },
      { selected: instance },
    )
    await expect(dispatch.run(['echo', 'ok'], { cwd, sandbox: binding })).resolves.toMatchObject({
      stdout: 'local-provider',
    })
    expect(calls).toHaveLength(1)
    await expect(instance.exec({ argv: ['echo'], cwd })).rejects.toThrow(/bound execution policy/)
    const peerRoot = join(cwd, 'peer')
    const peer = await provider.create({ workspaceRoot: peerRoot })
    await instance.dispose()
    await expect(instance.exec({ argv: ['echo'], cwd, policy, enforcement })).rejects.toThrow(/disposed/)
    await expect(
      peer.exec({
        argv: ['echo'],
        cwd: peerRoot,
        policy: { ...policy, workspaceRoot: peerRoot },
        enforcement,
      }),
    ).resolves.toMatchObject({ stdout: 'local-provider' })
    await peer.dispose()
  })

  it('refuses an unavailable required sandbox at the real Host workspace boundary and permits the explicit override', async () => {
    const dataDir = mkdtempSync(join(cwd, 'host-'))
    const selected = ['standard', 'read-only', 'workspace-write', 'full-access']
    const testHost = await createTestHost({
      dataDir,
      disableSessionTitle: true,
      profileInputs: {
        user: { name: 'local-dev', presets: { default: 'workspace-write', allowed: selected } },
      },
      presets: Object.fromEntries(selected.map((name) => [name, loadPreset(name)])),
      packages: {
        '@agnes/base': {
          sandboxWorkspaceProbe: (input) =>
            sandboxWorkspaceProbe({
              ...input,
              probeExec: async () => ({
                code: 127,
                stdout: '',
                stderr: 'missing',
                truncated: false,
                timedOut: false,
              }),
            }),
          plugins: [
            {
              declaration: {
                id: 'loop:agnes.default',
                export: 'defaultLoopPlugin',
                apiRange: '^1.4.0',
                default: true,
                inject: ['loops'],
                provide: [],
                runtime: 'in-process',
              },
              entry: normalizePluginExport(defaultLoopPlugin),
            },
            {
              declaration: {
                id: 'tool-policy:default',
                export: 'toolPolicyPlugin',
                apiRange: '^1.4.0',
                default: true,
                inject: ['toolPolicies'],
                provide: [],
                runtime: 'in-process',
              },
              entry: normalizePluginExport(toolPolicyPlugin),
            },
          ],
        },
      },
    })
    try {
      await expect(testHost.host.createSession({ cwd: dataDir })).rejects.toThrow(/L1 sandbox unavailable/)
      await expect(testHost.host.createSession({ cwd: dataDir, preset: 'read-only' })).rejects.toThrow(
        /L1 sandbox unavailable/,
      )
      const full = await testHost.host.createSession({ cwd: dataDir, preset: 'full-access' })
      expect(full.yolo).toBe(true)
      await expect(testHost.host.setSessionPreset(full.key, 'workspace-write')).rejects.toMatchObject({
        code: 'E_PRESET_UNSUPPORTED',
        detail: { reason: 'workspace-sandbox-change' },
      })
      await full.setYolo(false, full.d.actor)
      const key = full.key
      await full.close()
      const reopened = await testHost.host.createSession({ key, cwd: dataDir })
      expect(reopened.preset.name).toBe('full-access')
      expect(reopened.yolo).toBe(false)
      await reopened.close()
      const configuration = createConfigurationService({
        home: dataDir,
        profile: 'local-dev',
        profileDir: join(dataDir, 'profiles', 'local-dev'),
      })
      const admin = createAdminSessionSelection(
        {
          presets: async () => testHost.host.profile.presets.allowed,
          loops: async () => testHost.host.kernel.loops.catalog(),
          modelAdapters: async () => testHost.host.modelAdapterCatalog(),
          models: async () => [],
        },
        configuration,
      )
      const saved = await admin.saveDefaults({ revision: 0, defaults: { preset: 'full-access' } })
      const fromAdmin = await testHost.host.createSession({ key: 'admin-selected', cwd: dataDir })
      expect(fromAdmin.preset.name).toBe('full-access')
      await fromAdmin.close()
      await admin.saveDefaults({ revision: saved.revision, defaults: { preset: 'read-only' } })
      const retained = await testHost.host.createSession({ key: 'admin-selected', cwd: dataDir })
      expect(retained.preset.name).toBe('full-access')
      await retained.close()
      await expect(testHost.host.createSession({ key: 'admin-new', cwd: dataDir })).rejects.toThrow(
        /L1 sandbox unavailable/,
      )
    } finally {
      await testHost.host.close()
    }
  })

  it('keeps the policy gate closed for the local backend and open for an external provider', async () => {
    const calls: string[][] = []
    const inner = {
      async run(argv: string[]) {
        calls.push(argv)
        return { code: 0, stdout: '', stderr: '', truncated: false, timedOut: false }
      },
      async killAll() {},
    }
    const digest = 'a'.repeat(64)
    const run = createPolicyExec(inner, {
      boundDigest: () => digest,
      state: () => ({ backend: 'none', onUnavailable: 'deny' }),
      authorizeCwd: async (path) => path,
    })
    await expect(run(['echo'], { cwd, sandbox: { policyDigest: digest, backend: 'none' } })).rejects.toThrow(
      /SANDBOX_UNAVAILABLE/,
    )
    await run(['echo'], { cwd, sandbox: { policyDigest: digest, backend: 'none', provider: 'box' } })
    expect(calls).toEqual([['echo']])
  })
})
