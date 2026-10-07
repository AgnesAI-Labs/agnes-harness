import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@agnes/cordis'
import {
  LOCAL_SANDBOX_PROVIDER_ID,
  type SandboxProvider,
  sandboxUnavailable,
} from '@agnes/extension-api'
import { afterAll, describe, expect, it } from 'vitest'
import { createExec, createPolicyExec } from '../../src/adapters/exec.js'
import { createLocalSandboxProvider } from '../../src/adapters/sandbox-local.js'
import {
  bindStartupSandboxProvider,
  createSandboxDispatchExec,
  installSandboxProviders,
  readSandboxStartupConfig,
  type SandboxProviderSlot,
} from '../../src/adapters/sandbox-providers.js'

const cwd = mkdtempSync(join(tmpdir(), 'agnes-sandbox-provider-'))
const nodeEnv = process.env.ELECTRON_RUN_AS_NODE
  ? { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE }
  : {}

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
      }),
      dispose() {},
    }),
  }
}

describe('sandbox providers', () => {
  it('reads sandbox.provider and rejects unknown keys', () => {
    expect(readSandboxStartupConfig(undefined)).toBeUndefined()
    expect(readSandboxStartupConfig({ provider: 'docker' })).toEqual({ provider: 'docker' })
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
    expect(registry.catalog().find((entry) => entry.id === LOCAL_SANDBOX_PROVIDER_ID)?.capabilities).toMatchObject({
      network: false,
      fsWrite: [],
      available: true,
    })
    expect(() => registry.register(box('box'))).toThrow(/duplicate sandbox provider/)
    const selected = await registry.select(LOCAL_SANDBOX_PROVIDER_ID, { workspaceRoot: cwd })
    expect(selected.id).toBe(LOCAL_SANDBOX_PROVIDER_ID)
    await expect(registry.select('box')).rejects.toThrow(/requires a restart/)
    await expect(registry.select('missing')).rejects.toThrow(/requires a restart/)
  })

  it('runs a local command and stops it when the signal aborts', async () => {
    const exec = createExec({ detached: false })
    const instance = await createLocalSandboxProvider(exec, process.platform, { ownProcesses: true }).create({})
    const ok = await instance.exec({
      argv: [process.execPath, '-e', 'process.stdout.write("ok")'],
      cwd,
      env: nodeEnv,
    })
    expect(ok).toMatchObject({ code: 0, stdout: 'ok', timedOut: false })
    await expect(
      instance.exec({
        argv: [process.execPath, '-e', 'process.stdout.write("no")'],
        cwd,
        network: true,
      }),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    const signal = new AbortController()
    const pending = instance.exec({
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      cwd,
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
    await expect(bindStartupSandboxProvider({}, undefined, cwd, false)).resolves.toBe(LOCAL_SANDBOX_PROVIDER_ID)
    await expect(bindStartupSandboxProvider({}, { sandbox: { provider: 'docker' } }, cwd, true)).rejects.toThrow(
      /remote workspace/,
    )
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
    expect(localRan).toBe(false)
    expect(sandboxUnavailable('missing').code).toBe('SANDBOX_UNAVAILABLE')
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
    await expect(
      run(['echo'], { cwd, sandbox: { policyDigest: digest, backend: 'none' } }),
    ).rejects.toThrow(/SANDBOX_UNAVAILABLE/)
    await run(['echo'], { cwd, sandbox: { policyDigest: digest, backend: 'none', provider: 'box' } })
    expect(calls).toEqual([['echo']])
  })
})
