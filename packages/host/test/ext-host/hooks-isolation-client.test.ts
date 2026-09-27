import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createWorkspaceInvocationPort,
  WORKSPACE_HOOK_SANDBOX,
  type WorkspaceHookSandbox,
  type WorkspaceInvocationSource,
} from '@agnes/core'
import type {
  ExtensionAPI,
  HookEvent,
  HookHandler,
  HookPayloadMap,
  LeaseView,
  PlatformFacts,
  SessionRef,
} from '@agnes/extension-api'
import { unavailableProjections } from '@agnes/extension-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  connectIsolatedHooksRunner,
  type HooksRunnerBootstrap,
  type IsolatedHooksRunner,
  isolatedHooksRunnerFactory,
} from '../../src/ext-host/hooks-isolation-client.js'

const packagedNodeRoot = process.env.AGNES_TEST_BUNDLED_NODE_ROOT
const packagedArtifact = process.env.AGNES_TEST_RUNNER_ARTIFACT
const usesPackagedRuntime = Boolean(packagedNodeRoot && packagedArtifact)
const runnerExecutable = usesPackagedRuntime
  ? resolve(packagedNodeRoot as string, 'bin/node')
  : process.execPath
const runnerEntry = usesPackagedRuntime
  ? resolve(packagedArtifact as string, 'hooks-runner.mjs')
  : resolve(import.meta.dirname, '../../../base/src/hooks-isolation-runner.ts')
const runnerArguments = usesPackagedRuntime ? [runnerEntry] : ['--import', 'tsx', runnerEntry]
const testNodeEnvironment =
  !usesPackagedRuntime && process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}
const lease: LeaseView = {
  expiresAt: '2099-01-01T00:00:00.000Z',
  scope: { events: true },
  budget: { remaining: 100 },
}
const session: SessionRef = {
  key: 'isolated-1',
  lane: 'main',
  workspaceRoot: '/workspace',
  turn: 1,
  step: 1,
}
const platform: PlatformFacts = Object.freeze({
  shell: 'posix',
  fs: Object.freeze({ caseSensitive: true, pathSep: '/' }),
  terminal: Object.freeze({ color: false }),
})

function fixture() {
  const nonce = randomUUID()
  const packageDigest = 'package-sha256'
  const manifestDigest = 'manifest-sha256'
  const child = spawn(runnerExecutable, runnerArguments, {
    cwd: resolve(import.meta.dirname, '../../..'),
    env: {
      ...testNodeEnvironment,
      AGNES_ISOLATION_NONCE: nonce,
      AGNES_PACKAGE_DIGEST: packageDigest,
      AGNES_MANIFEST_DIGEST: manifestDigest,
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const bootstrap: HooksRunnerBootstrap = {
    nonce,
    packageDigest,
    manifestDigest,
    extensionId: 'agnes/hooks-runner',
    data: {
      groups: [
        { event: 'Emit', hooks: [{ type: 'command', command: 'emit' }] },
        { event: 'Parallel', hooks: [{ type: 'command', command: 'parallel' }] },
        { event: 'Serial', hooks: [{ type: 'command', command: 'serial' }] },
        { event: 'Waterfall', hooks: [{ type: 'command', command: 'waterfall' }] },
      ],
      map: {
        version: 'spike-1',
        events: {
          Emit: { to: ['subagent_start'] },
          Parallel: { to: ['session_start'] },
          Serial: { to: ['before_step'] },
          Waterfall: { to: ['context'] },
        },
      },
      profile: {
        name: 'test',
        resolvedProfileHash: null,
        dataDir: '/data',
        workspaceRoot: '/workspace',
        homeDir: '/virtual-home',
        limits: {},
        preset: { surface: 'cli', locale: 'zh-CN', sandbox: { network_allow: [] } },
      },
      lease,
      platform,
    },
  }
  return { child, bootstrap }
}

const running: Array<{ child: ReturnType<typeof spawn>; runner?: IsolatedHooksRunner }> = []
afterEach(async () => {
  for (const item of running.splice(0)) {
    await item.runner?.close().catch(() => undefined)
    item.child.kill('SIGKILL')
  }
})

function payload(event: HookEvent): HookPayloadMap[HookEvent] {
  if (event === 'subagent_start') return { childKey: 'child-1', kind: 'spawn', budget: null }
  if (event === 'session_start') return { reason: 'new', preset: 'default', cwd: '/workspace' }
  if (event === 'before_step') return { turn: 1, step: 1, budget: { remaining: 10, cap: 20 }, depth: 0 }
  return {
    sections: [],
    surfaceDigest: { nodes: 0, tokensEstimate: 0 },
    getSurface: () => [],
  }
}

describe('isolated hooks-runner spike', () => {
  it('adapts the fixed remote event list to ordinary host hook registrations', async () => {
    const registrations = new Map<HookEvent, HookHandler<HookEvent>>()
    const dispose = vi.fn()
    const close = vi.fn(async () => undefined)
    const invoke = vi.fn(async () => ({ block: false }))
    const runner = {
      pid: 42,
      events: ['before_step'],
      invoke,
      close,
      onFailure: () => () => undefined,
    } as unknown as IsolatedHooksRunner
    const api = {
      registerHook(event: HookEvent, handler: HookHandler<HookEvent>) {
        registrations.set(event, handler)
        return dispose
      },
    } as unknown as ExtensionAPI
    const returned = await isolatedHooksRunnerFactory(async () => runner)(api)
    const handler = registrations.get('before_step')
    expect(handler).toBeDefined()
    await handler?.(payload('before_step') as never, {
      projections: unavailableProjections,
      session,
      lease,
      replayed: false,
      platform,
      signal: new AbortController().signal,
      log: { debug() {}, info() {}, warn() {}, error() {} },
    })
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith(
      'before_step',
      expect.anything(),
      expect.objectContaining({ platform }),
      'before_step',
    )
    if (typeof returned === 'function') returned()
    expect(dispose).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('runs representatives of all four HookEngine modes through host capabilities', async () => {
    const state = fixture()
    const calls: string[] = []
    const capability = vi.fn(async (method: string, input: unknown) => {
      expect(method).toBe('exec')
      const command = ((input as { argv: string[] }).argv[1] ?? '').trim()
      calls.push(command)
      if (command === 'serial')
        return {
          code: 2,
          stdout: JSON.stringify({ decision: 'block', reason: 'blocked by isolated hook' }),
          stderr: '',
          truncated: false,
        }
      if (command === 'waterfall')
        return {
          code: 0,
          stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'isolated context' } }),
          stderr: '',
          truncated: false,
        }
      return { code: 0, stdout: '{}', stderr: '', truncated: false }
    })
    const runner = await connectIsolatedHooksRunner(state.child, state.bootstrap, capability)
    running.push({ ...state, runner })
    expect(runner.events).toEqual(['session_start', 'shutdown', 'before_step', 'context', 'subagent_start'])

    const context = { session, lease, replayed: false, platform, signal: new AbortController().signal }
    await expect(
      runner.invoke('subagent_start', payload('subagent_start') as never, context),
    ).resolves.toBeUndefined()
    await expect(
      runner.invoke('session_start', payload('session_start') as never, context),
    ).resolves.toBeUndefined()
    await expect(runner.invoke('before_step', payload('before_step') as never, context)).resolves.toEqual({
      block: true,
      reason: 'blocked by isolated hook',
    })
    await expect(runner.invoke('context', payload('context') as never, context)).resolves.toEqual({
      additionalContext: 'isolated context',
    })
    expect(calls).toEqual(['emit', 'parallel', 'serial', 'waterfall'])
    for (let index = 0; index < 5; index++)
      await runner.invoke('before_step', payload('before_step') as never, context)
    // A round trip takes well under a millisecond, so the 5 ms tail bound only fails when a few
    // samples in a batch land on a pause of the shared machine (a neighbouring test's burst or a
    // collection). Such pauses do not repeat batch after batch, while a real per-call cost does,
    // so the bound must hold for one of three batches of 50.
    const tails: number[] = []
    for (let batch = 0; batch < 3; batch++) {
      const samples: number[] = []
      for (let index = 0; index < 50; index++) {
        const started = performance.now()
        await runner.invoke('before_step', payload('before_step') as never, context)
        samples.push(performance.now() - started)
      }
      samples.sort((left, right) => left - right)
      const tail = samples[47] ?? Number.POSITIVE_INFINITY
      tails.push(tail)
      if (tail < 5) break
    }
    expect(
      Math.min(...tails),
      `96th-percentile batches: ${tails.map((t) => t.toFixed(2)).join(', ')} ms`,
    ).toBeLessThan(5)
  })

  it('keeps isolated capabilities bound to each session fitted sandbox', async () => {
    const state = fixture()
    state.bootstrap.data = {
      ...state.bootstrap.data,
      groups: [],
      workspaceSnapshots: true,
      map: { version: 'dynamic-1', events: { UserPromptSubmit: { to: ['before_step'] } } },
    }
    const roots: string[] = []
    const fitted = (root: string): WorkspaceHookSandbox => ({
      enforcement: () => ({ level: 'full', scope: ['process'] }),
      exec: async (_argv, options) => {
        roots.push(`${root}:${options.cwd}`)
        return { code: 0, stdout: '{}', stderr: '', truncated: false }
      },
    })
    const runner = await connectIsolatedHooksRunner(
      state.child,
      state.bootstrap,
      async (_method, input, _signal, invocation) => {
        if (!invocation.sandbox) throw new Error('missing fitted workspace sandbox')
        const request = input as { argv: string[]; options: Parameters<WorkspaceHookSandbox['exec']>[1] }
        return invocation.sandbox.exec(request.argv, request.options)
      },
    )
    running.push({ ...state, runner })
    const registrations = new Map<HookEvent, HookHandler<HookEvent>>()
    const dispose = await isolatedHooksRunnerFactory(async () => runner)({
      registerHook(event: HookEvent, handler: HookHandler<HookEvent>) {
        registrations.set(event, handler)
        return () => registrations.delete(event)
      },
    } as unknown as ExtensionAPI)
    const handler = registrations.get('before_step')
    if (!handler) throw new Error('isolated dynamic handler was not registered')
    const workspaceHooks = {
      workspaceDigest: 'sha256-isolated',
      policyRevision: 'policy-1',
      hooks: [{ event: 'UserPromptSubmit', hooks: [{ type: 'command', command: './isolated.sh' }] }],
    }
    for (const root of ['/workspace/one', '/workspace/two']) {
      await handler(
        payload('before_step') as never,
        {
          projections: unavailableProjections,
          session: { ...session, workspaceRoot: root },
          lease,
          replayed: false,
          platform,
          workspaceHooks,
          signal: new AbortController().signal,
          log: { debug() {}, info() {}, warn() {}, error() {} },
          [WORKSPACE_HOOK_SANDBOX]: fitted(root),
        } as never,
      )
    }
    expect(roots).toEqual(['/workspace/one:/workspace/one', '/workspace/two:/workspace/two'])
    if (typeof dispose === 'function') await dispose()
  })

  it('drains an unawaited isolated event capability after the runner transport closes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-isolated-capability-drain-'))
    const ext = join(root, 'extension')
    mkdirSync(ext)
    const manifestFile = join(ext, 'agnes.extension.json')
    const entry = join(ext, 'index.js')
    writeFileSync(
      manifestFile,
      JSON.stringify({
        id: 'fixture/unawaited-event',
        version: '1.0.0',
        apiRange: '^1.1',
        entry: './index.js',
        runtime: { supports: ['isolated'] },
        capabilities: { hooks: ['before_step'] },
      }),
    )
    writeFileSync(
      entry,
      `export default (api) => {
  api.registerHook('before_step', () => {
    void api.events.append('audit', { source: 'unawaited' });
    return {};
  });
};`,
    )
    const digest = (file: string) => `sha256-${createHash('sha256').update(readFileSync(file)).digest('hex')}`
    const nonce = randomUUID()
    const manifestDigest = digest(manifestFile)
    const child = spawn(runnerExecutable, runnerArguments, {
      cwd: resolve(import.meta.dirname, '../../..'),
      env: {
        ...testNodeEnvironment,
        AGNES_ISOLATION_NONCE: nonce,
        AGNES_PACKAGE_DIGEST: 'package-sha256',
        AGNES_MANIFEST_DIGEST: manifestDigest,
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let capabilityEntered!: () => void
    let finishCapability!: () => void
    const capabilityStarted = new Promise<void>((resolve) => {
      capabilityEntered = resolve
    })
    const runner = await connectIsolatedHooksRunner(
      child,
      {
        nonce,
        packageDigest: 'package-sha256',
        manifestDigest,
        extensionId: 'fixture/unawaited-event',
        data: {
          kind: 'extension',
          packageDirectory: root,
          entry,
          entryDigest: digest(entry),
          manifestFile,
          context: {
            extId: 'fixture/unawaited-event',
            version: '1.0.0',
            trust: 'trusted',
            lease,
            info: { agnesVersion: '0.1.0', apiVersion: '1.1.0', profileName: 'test' },
            platform,
          },
        },
      },
      async (method) => {
        expect(method).toBe('events.append')
        capabilityEntered()
        return new Promise<number>((resolve) => {
          finishCapability = () => resolve(1)
        })
      },
    )
    running.push({ child, runner })
    const registrations = new Map<HookEvent, HookHandler<HookEvent>>()
    const dispose = await isolatedHooksRunnerFactory(async () => runner)({
      registerHook(event: HookEvent, handler: HookHandler<HookEvent>) {
        registrations.set(event, handler)
        return () => registrations.delete(event)
      },
    } as unknown as ExtensionAPI)
    const handler = registrations.get('before_step')
    if (!handler) throw new Error('isolated hook was not registered')
    const release = vi.fn()
    const invocationSource: WorkspaceInvocationSource = {
      root: '/workspace',
      fs: {
        read: async () => new Uint8Array(),
        write: async () => undefined,
        list: async () => [],
        stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0 }),
      },
      ready: async () => ({ confine: async (argv) => argv }),
      hookSnapshot: async () => ({ workspaceDigest: 'sha256-hooks', policyRevision: 'policy-1', hooks: [] }),
      hookSandbox: {
        enforcement: () => ({ level: 'full', scope: ['process'] }),
        exec: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }),
      },
      approval: { ask: async () => 'rejected', resume: async () => null },
      checkpoint: {
        snapshot: async () => ({ id: 'checkpoint' }),
        rewind: async () => undefined,
        list: async () => [],
      },
    }
    const port = createWorkspaceInvocationPort(() => ({ source: invocationSource, release }))
    let sandbox!: WorkspaceHookSandbox
    const active = port.run(async (view) => {
      sandbox = view.hookSandbox()
      return handler(
        payload('before_step') as never,
        {
          projections: unavailableProjections,
          session,
          lease,
          replayed: false,
          platform,
          signal: new AbortController().signal,
          log: { debug() {}, info() {}, warn() {}, error() {} },
          [WORKSPACE_HOOK_SANDBOX]: sandbox,
        } as never,
      )
    })
    void active.catch(() => undefined)

    try {
      await capabilityStarted
      child.kill('SIGKILL')
      await vi.waitFor(() => expect(() => sandbox.enforcement()).toThrow('E_WORKSPACE_CLOSED'))
      expect(release).not.toHaveBeenCalled()
      finishCapability()
      await expect(active).rejects.toThrow('isolated hooks runner exited')
      expect(release).toHaveBeenCalledOnce()
    } finally {
      if (typeof dispose === 'function') await Promise.resolve(dispose()).catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects active invocation when the child crashes and leaves the host process alive', async () => {
    const state = fixture()
    let entered!: () => void
    const called = new Promise<void>((resolve) => {
      entered = resolve
    })
    const runner = await connectIsolatedHooksRunner(state.child, state.bootstrap, async () => {
      entered()
      return new Promise(() => undefined)
    })
    running.push({ ...state, runner })
    const pending = runner.invoke('before_step', payload('before_step') as never, {
      session,
      lease,
      replayed: false,
      platform,
      signal: new AbortController().signal,
    })
    await called
    state.child.kill('SIGKILL')
    await expect(pending).rejects.toThrow('isolated hooks runner exited')
    expect(process.pid).toBeGreaterThan(0)
  })

  it('notifies a failure observer registered just after the child exit', async () => {
    const state = fixture()
    const runner = await connectIsolatedHooksRunner(state.child, state.bootstrap, async () => undefined)
    running.push({ ...state, runner })
    const exited = new Promise<void>((resolve) => state.child.once('exit', () => resolve()))
    state.child.kill('SIGKILL')
    await exited
    const failed = vi.fn()
    runner.onFailure(failed)
    expect(failed).toHaveBeenCalledOnce()
  })

  it('does not report an expected child exit during graceful close as a failure', async () => {
    const state = fixture()
    const runner = await connectIsolatedHooksRunner(state.child, state.bootstrap, async () => undefined)
    running.push({ ...state, runner })
    const failed = vi.fn()
    runner.onFailure(failed)
    const exited = new Promise<void>((resolve) => state.child.once('exit', () => resolve()))
    await runner.close()
    await exited
    expect(failed).not.toHaveBeenCalled()
  })

  it('refuses a nonce mismatch before loading extension code', async () => {
    const state = fixture()
    running.push(state)
    await expect(
      connectIsolatedHooksRunner(state.child, { ...state.bootstrap, nonce: 'wrong' }, async () => undefined),
    ).rejects.toThrow('handshake mismatch')
  })

  it('kills a runner that never starts the protocol before the startup deadline', async () => {
    const child = spawn(runnerExecutable, ['-e', 'setInterval(() => undefined, 1000)'], {
      env: testNodeEnvironment,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const state = fixture()
    state.child.kill('SIGKILL')
    running.push({ child })
    await expect(
      connectIsolatedHooksRunner(child, state.bootstrap, async () => undefined, 25),
    ).rejects.toThrow('runner startup timed out')
  })

  it('revokes the active capability before forwarding cancellation', async () => {
    const state = fixture()
    let capabilitySignal!: AbortSignal
    let entered!: () => void
    const called = new Promise<void>((resolve) => {
      entered = resolve
    })
    const runner = await connectIsolatedHooksRunner(
      state.child,
      state.bootstrap,
      async (_method, _input, signal) => {
        capabilitySignal = signal
        entered()
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('revoked')), { once: true })
        })
      },
    )
    running.push({ ...state, runner })
    const controller = new AbortController()
    const pending = runner.invoke('before_step', payload('before_step') as never, {
      session,
      lease,
      replayed: false,
      platform,
      signal: controller.signal,
    })
    await called
    controller.abort()
    expect(capabilitySignal.aborted).toBe(true)
    await expect(pending).rejects.toThrow('isolated hook cancelled')
  })

  it('kills a child that does not settle during the cancellation grace period', async () => {
    const state = fixture()
    let entered!: () => void
    const called = new Promise<void>((resolve) => {
      entered = resolve
    })
    const runner = await connectIsolatedHooksRunner(state.child, state.bootstrap, async () => {
      entered()
      return new Promise(() => undefined)
    })
    running.push({ ...state, runner })
    const failed = new Promise<Error>((resolve) => runner.onFailure(resolve))
    const controller = new AbortController()
    const pending = runner.invoke('before_step', payload('before_step') as never, {
      session,
      lease,
      replayed: false,
      platform,
      signal: controller.signal,
    })
    await called
    controller.abort()
    await expect(pending).rejects.toThrow('isolated hook cancelled')
    expect((await failed).message).toContain('runner did not settle cancelled invocation')
    expect(process.pid).toBeGreaterThan(0)
  })

  it('rejects an oversized frame before allocating its body', async () => {
    const child = spawn(
      runnerExecutable,
      ['-e', 'const b=Buffer.alloc(4); b.writeUInt32BE(1024*1024+1); process.stdout.write(b)'],
      { env: testNodeEnvironment, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const state = fixture()
    state.child.kill('SIGKILL')
    running.push({ child })
    await expect(connectIsolatedHooksRunner(child, state.bootstrap, async () => undefined)).rejects.toThrow(
      'frame exceeds 1 MiB',
    )
  })
})
