import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { type SandboxSeam, WORKSPACE_HOOK_SANDBOX } from '@agnes/core'
import { testFsPolicy } from '@agnes/core/testkit'
import type {
  ExtensionAPI,
  HookContext,
  HookEvent,
  HookHandler,
  HookPayloadMap,
  HookReturnMap,
} from '@agnes/extension-api'
import { unavailableProjections } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { createEcosystemExtensions } from '../../../src/ecosystem.js'
import { fakeSeamInit } from '../../../testkit/seam-init.js'
import { type CcHookGroup, hooksRunnerExtension, preparedHooksRunnerExtension } from '../src/index.js'
import type { CcHookMap } from '../src/map.js'

const map = JSON.parse(
  readFileSync(new URL('../generated/cc-hook-map.json', import.meta.url), 'utf8'),
) as CcHookMap
const enc = new TextEncoder()

function sandbox(
  exec: SandboxSeam['exec'],
  enforcement: ReturnType<SandboxSeam['enforcement']> = {
    level: 'full',
    scope: ['process'],
  },
): SandboxSeam {
  const value: SandboxSeam = {
    forWorkspace: async () => value,
    exec,
    confine: async (argv) => ['sandbox', ...argv],
    fsPolicy: () => testFsPolicy('/work/proj'),
    enforcement: () => enforcement,
  }
  return value
}

function fakeApi() {
  const handlers = new Map<HookEvent, HookHandler<HookEvent>>()
  const warnings: Array<{ message: string; fields?: unknown }> = []
  const events: Array<{ name: string; data: unknown }> = []
  const disposed: HookEvent[] = []
  const api = {
    registerHook: (event: HookEvent, handler: HookHandler<HookEvent>) => {
      handlers.set(event, handler)
      return () => {
        handlers.delete(event)
        disposed.push(event)
      }
    },
    events: {
      append: async (name: string, data: unknown) => {
        events.push({ name, data })
        return events.length
      },
    },
    ctx: {
      log: {
        debug() {},
        info() {},
        warn: (message: string, fields?: unknown) => warnings.push({ message, fields }),
        error() {},
      },
    },
  } as unknown as ExtensionAPI
  return { api, disposed, events, handlers, warnings }
}

const context: HookContext = {
  session: { key: 'session-1', lane: 'main', workspaceRoot: '/work/proj', turn: 2, step: 3 },
  projections: unavailableProjections,
  replayed: false,
  signal: new AbortController().signal,
  lease: { expiresAt: '2099-01-01T00:00:00.000Z', scope: {}, budget: { remaining: 10 } },
  log: { debug() {}, info() {}, warn() {}, error() {} },
  platform: { shell: 'posix', fs: { caseSensitive: true, pathSep: '/' }, terminal: { color: false } },
}

async function invoke<E extends HookEvent>(
  state: ReturnType<typeof fakeApi>,
  event: E,
  payload: HookPayloadMap[E],
): Promise<HookReturnMap[E]> {
  const handler = state.handlers.get(event)
  if (!handler) throw new Error(`no handler for ${event}`)
  return handler(payload as never, context) as Promise<HookReturnMap[E]>
}

const toolCall = (name: string): HookPayloadMap['tool_call'] => ({
  toolUseId: 'tool-1',
  name,
  args: { command: 'rm -rf /' },
  meta: {
    isReadOnly: false,
    isDestructive: true,
    isConcurrencySafe: false,
    isOpenWorld: true,
    replay: 'never',
    costHint: undefined,
    deferLoading: false,
    requiresApproval: 'destructive',
  },
  actor: { id: 'user-1', org: 'local', role: 'owner', deptPath: [], attrs: {} },
  taint: false,
})

describe('hooksRunnerExtension', () => {
  it('loads both fenced configs, matches tools, uses the sandbox seam, and warns once', async () => {
    const init = fakeSeamInit({
      files: {
        '.agh/hooks.json': JSON.stringify({
          hooks: {
            Notification: [{ hooks: [{ type: 'command', command: 'must-not-run' }] }],
          },
        }),
      },
      preset: { locale: 'zh-CN', surface: 'cli' },
    })
    init.data.set(
      '/home/u/.agh/hooks.json',
      enc.encode(
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: 'shell|mcp__.*',
                hooks: [
                  { type: 'command', command: './observe.sh' },
                  { type: 'command', command: './deny.sh', timeout: 0.5 },
                ],
              },
            ],
          },
        }),
      ),
    )
    const calls: Array<{ argv: string[]; opts: Record<string, unknown> }> = []
    const seam = sandbox(async (argv, opts) => {
      calls.push({ argv, opts })
      return argv[1] === './deny.sh'
        ? { code: 2, stdout: '', stderr: 'rm is forbidden', truncated: false }
        : {
            code: 0,
            stdout: '{"hookSpecificOutput":{"updatedInput":{"safe":true}}}',
            stderr: '',
            truncated: false,
          }
    })
    const state = fakeApi()
    const dispose = await hooksRunnerExtension(init, { map, sandbox: seam })(state.api)

    expect(state.handlers.has('tool_call')).toBe(true)
    await expect(invoke(state, 'tool_call', toolCall('read'))).resolves.toEqual({ allow: true })
    await expect(invoke(state, 'tool_call', toolCall('shell'))).resolves.toEqual({
      allow: false,
      reason: 'rm is forbidden',
    })
    await expect(invoke(state, 'tool_call', toolCall('shell'))).resolves.toEqual({
      allow: false,
      reason: 'rm is forbidden',
    })

    expect(calls).toHaveLength(4)
    expect(calls[0]).toMatchObject({
      argv: ['$SHELL', './observe.sh'],
      opts: {
        cwd: '/work/proj',
        env: {
          AGNES_SESSION_ID: 'session-1',
          AGNES_STEP_ID: '2/3',
          AGNES_SURFACE: 'cli',
          AGNES_LOCALE: 'zh-CN',
          AGNES_PRINCIPAL: 'user-1',
          AGNES_PLUGIN_ROOT: '/home/u/.agh',
        },
        signal: context.signal,
      },
    })
    expect(calls[1]?.opts.timeoutMs).toBe(500)
    expect(state.events).toEqual([
      { name: 'unsupported', data: expect.objectContaining({ event: 'Notification' }) },
      {
        name: 'unsupported',
        data: expect.objectContaining({ event: 'PreToolUse', field: 'updatedInput' }),
      },
    ])
    expect(state.warnings).toHaveLength(2)

    expect(dispose).toBeTypeOf('function')
    ;(dispose as () => void)()
    expect(state.disposed).toContain('tool_call')
    expect(state.handlers.size).toBe(0)
  })

  it('refuses configured commands when no enforcing sandbox process scope exists', async () => {
    const init = fakeSeamInit({
      files: {
        '.agh/hooks.json': JSON.stringify({
          hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }] },
        }),
      },
    })
    const state = fakeApi()
    const deniedNone = hooksRunnerExtension(init, {
      map,
      sandbox: sandbox(vi.fn(), { level: 'none', scope: [] }),
    })(state.api)
    expect(state.handlers.size).toBeGreaterThan(0)
    await expect(deniedNone).rejects.toThrow('E_SANDBOX_UNAVAILABLE')
    expect(state.handlers.size).toBe(0)

    const deniedFileOnly = hooksRunnerExtension(init, {
      map,
      sandbox: sandbox(vi.fn(), { level: 'full', scope: ['file'] }),
    })(state.api)
    expect(state.handlers.size).toBeGreaterThan(0)
    await expect(deniedFileOnly).rejects.toThrow('E_SANDBOX_UNAVAILABLE')
    expect(state.handlers.size).toBe(0)
  })

  it('reads workspace hooks from .agh/hooks.json and ignores a legacy .agnes/hooks.json', async () => {
    const hooks = (command: string) =>
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command }] }] } })
    const init = fakeSeamInit({
      files: { '.agh/hooks.json': hooks('current'), '.agnes/hooks.json': hooks('legacy') },
    })
    const ran: string[][] = []
    const seam = sandbox(async (argv) => {
      ran.push(argv)
      return { code: 0, stdout: '', stderr: '', truncated: false }
    })
    const state = fakeApi()
    await hooksRunnerExtension(init, { map, sandbox: seam })(state.api)
    await invoke(state, 'tool_call', toolCall('shell'))
    expect(ran).toEqual([['$SHELL', 'current']])
  })

  it('exposes the real factory through the ecosystem adapter', async () => {
    const init = fakeSeamInit()
    const state = fakeApi()
    const initialized = createEcosystemExtensions(init).hooksRunner({
      map,
      sandbox: sandbox(vi.fn()),
    })(state.api)
    // Registration is complete before the async factory result yields to configuration I/O.
    expect(state.handlers.size).toBeGreaterThan(0)
    await initialized
    expect(state.handlers.size).toBeGreaterThan(0)
    expect(state.handlers.has('tool_call')).toBe(true)
  })
})

describe('trusted unconfined command Hooks', () => {
  const bytes = JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'trusted-command' }] }] },
  })
  const digest = `sha256-${createHash('sha256').update(bytes).digest('hex')}`
  const partial = { level: 'partial' as const, scope: ['file' as const] }
  const result = { code: 2, stdout: '', stderr: 'policy says no', truncated: false }
  it.each([true, false])('rejects a supplied grant on POSIX (caseSensitive=%s)', async (caseSensitive) => {
    const init = fakeSeamInit({
      files: { '.agh/hooks.json': bytes },
      platform: { shell: () => 'posix', fs: () => ({ pathSep: '/', caseSensitive }) },
      preset: { sandbox: { on_unavailable: 'allow' } },
    })
    const permits = vi.fn(() => true)
    init.trustedHookCommands = { allowsUnconfined: permits }
    const exec = vi.fn(async () => result)
    const state = fakeApi()
    await expect(
      hooksRunnerExtension(init, { map, sandbox: sandbox(exec, partial) })(state.api),
    ).rejects.toThrow('E_SANDBOX_UNAVAILABLE')
    expect(exec).not.toHaveBeenCalled()
    expect(permits).not.toHaveBeenCalled()
    expect(state.handlers.size).toBe(0)
  })
  it('uses the same configuration bytes, the bound exec and JSON stdin, and rechecks permission before every command', async () => {
    const init = fakeSeamInit({
      platform: { shell: () => 'powershell', fs: () => ({ pathSep: '\\', caseSensitive: false }) },
      files: { '.agh/hooks.json': bytes },
      preset: { sandbox: { on_unavailable: 'allow' } },
    })
    let allowed = true
    const permits = vi.fn(
      (source: string, value: string) => allowed && source === 'workspace' && value === digest,
    )
    init.trustedHookCommands = { allowsUnconfined: permits }
    const exec = vi.fn(async () => result),
      state = fakeApi()
    const read = vi.spyOn(init.adapters.fs, 'read')
    await hooksRunnerExtension(init, { map, sandbox: sandbox(exec, partial) })(state.api)
    expect(read).toHaveBeenCalledTimes(1)
    expect(exec).not.toHaveBeenCalled()
    expect(await invoke(state, 'tool_call', toolCall('shell'))).toEqual({
      allow: false,
      reason: 'policy says no',
    })
    const call = exec.mock.calls[0] as unknown as [string[], { stdin: string; cwd: string }]
    expect(call[0]).toEqual(['$SHELL', 'trusted-command'])
    expect(JSON.parse(call[1].stdin)).toMatchObject({ session_id: context.session.key })
    expect(state.warnings).toEqual([
      {
        message: 'trusted Hook commands run without process isolation',
        fields: { source: 'workspace', configDigest: digest },
      },
    ])
    allowed = false
    await expect(invoke(state, 'tool_call', toolCall('shell'))).rejects.toThrow('E_SANDBOX_UNAVAILABLE')
    expect(exec).toHaveBeenCalledTimes(1)
  })
  it.each(['missing', 'changed', 'wrong-source', 'required', 'deny', 'unbound', 'mixed'])(
    'refuses %s without executing or registering a command',
    async (mode) => {
      const init = fakeSeamInit({
        platform: { shell: () => 'powershell', fs: () => ({ pathSep: '\\', caseSensitive: false }) },
        files: { '.agh/hooks.json': mode === 'changed' ? `${bytes} ` : bytes },
        preset: {
          sandbox: { on_unavailable: mode === 'deny' ? 'deny' : 'allow', required: mode === 'required' },
        },
      })
      if (mode === 'mixed') init.data.set('/home/u/.agh/hooks.json', enc.encode(bytes))
      if (mode !== 'missing')
        init.trustedHookCommands = {
          allowsUnconfined: (source, value) =>
            source === (mode === 'wrong-source' ? 'data' : 'workspace') && value === digest,
        }
      const exec = vi.fn(async () => result),
        state = fakeApi()
      await expect(
        hooksRunnerExtension(init, {
          map,
          sandbox: sandbox(exec, mode === 'unbound' ? { level: 'none', scope: [] } : partial),
        })(state.api),
      ).rejects.toThrow('E_SANDBOX_UNAVAILABLE')
      expect(exec).not.toHaveBeenCalled()
      expect(state.handlers.size).toBe(0)
    },
  )
  it('copies prepared groups and grant identities before registration, so callers cannot change an authorized command', async () => {
    const init = fakeSeamInit({
      platform: { shell: () => 'powershell', fs: () => ({ pathSep: '\\', caseSensitive: false }) },
      preset: { sandbox: { on_unavailable: 'allow' } },
    })
    init.trustedHookCommands = {
      allowsUnconfined: (source, value) => source === 'workspace' && value === digest,
    }
    const group: CcHookGroup = { event: 'PreToolUse', hooks: [{ type: 'command', command: 'original' }] }
    const identity = { source: 'workspace' as const, configDigest: digest }
    const exec = vi.fn(async () => result),
      state = fakeApi()
    const factory = preparedHooksRunnerExtension(
      init,
      { map, sandbox: sandbox(exec, partial) },
      [group],
      new Map([[group, identity]]),
    )
    group.hooks.splice(0, 1, { type: 'command', command: 'replacement' })
    identity.configDigest = 'changed'
    await factory(state.api)
    await invoke(state, 'tool_call', toolCall('shell'))
    expect(exec).toHaveBeenCalledWith(['$SHELL', 'original'], expect.anything())
  })

  it('selects one workspace snapshot per invocation and sees changes on the next invocation', async () => {
    const init = fakeSeamInit({ preset: { locale: 'en', surface: 'cli' } })
    const runHttp = vi.fn(async () => ({ exitCode: 2, stdout: '', stderr: 'blocked by workspace' }))
    const state = fakeApi()
    await preparedHooksRunnerExtension(
      init,
      { map, sandbox: sandbox(vi.fn()), runHttp, workspaceSnapshots: true },
      [],
    )(state.api)
    const handler = state.handlers.get('before_step')
    if (!handler) throw new Error('dynamic before_step handler was not registered')
    const payload: HookPayloadMap['before_step'] = {
      turn: 1,
      step: 1,
      depth: 0,
      budget: { cap: 10, remaining: 10 },
    }
    const configured: HookContext = {
      ...context,
      workspaceHooks: {
        workspaceDigest: 'sha256-first',
        policyRevision: 'policy-1',
        hooks: [
          {
            event: 'UserPromptSubmit',
            hooks: [{ type: 'http', url: 'https://hooks.example.test/first' }],
          },
        ],
      },
    }

    await expect(handler(payload, configured)).resolves.toEqual({
      block: true,
      reason: 'blocked by workspace',
    })
    await expect(
      handler(payload, {
        ...configured,
        workspaceHooks: {
          workspaceDigest: 'sha256-empty',
          policyRevision: 'policy-2',
          hooks: [],
        },
      }),
    ).resolves.toEqual({})
    expect(runHttp).toHaveBeenCalledTimes(1)
    expect(runHttp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ url: 'https://hooks.example.test/first' }),
      expect.anything(),
    )
  })

  it('executes two sessions through their own fitted sandbox instead of the startup sandbox', async () => {
    const init = fakeSeamInit({ preset: { locale: 'en', surface: 'cli' } })
    const startupExec = vi.fn(async () => ({ code: 0, stdout: '{}', stderr: '', truncated: false }))
    const firstExec = vi.fn(async () => ({ code: 0, stdout: '{}', stderr: '', truncated: false }))
    const secondExec = vi.fn(async () => ({ code: 0, stdout: '{}', stderr: '', truncated: false }))
    const state = fakeApi()
    await preparedHooksRunnerExtension(
      init,
      { map, sandbox: sandbox(startupExec), workspaceSnapshots: true },
      [],
    )(state.api)
    const handler = state.handlers.get('tool_call')
    if (!handler) throw new Error('dynamic tool_call handler was not registered')
    const workspaceHooks: HookContext['workspaceHooks'] = {
      workspaceDigest: 'sha256-command',
      policyRevision: 'policy-1',
      hooks: [{ event: 'PreToolUse', hooks: [{ type: 'command', command: './workspace.sh' }] }],
    }
    const first = {
      ...context,
      session: { ...context.session, workspaceRoot: '/workspace/one' },
      workspaceHooks,
      [WORKSPACE_HOOK_SANDBOX]: sandbox(firstExec),
    } as HookContext
    const second = {
      ...context,
      session: { ...context.session, workspaceRoot: '/workspace/two' },
      workspaceHooks,
      [WORKSPACE_HOOK_SANDBOX]: sandbox(secondExec),
    } as HookContext

    await expect(handler(toolCall('shell'), first)).resolves.toEqual({ allow: true })
    await expect(handler(toolCall('shell'), second)).resolves.toEqual({ allow: true })
    expect(startupExec).not.toHaveBeenCalled()
    expect(firstExec).toHaveBeenCalledWith(
      ['$SHELL', './workspace.sh'],
      expect.objectContaining({ cwd: '/workspace/one' }),
    )
    expect(secondExec).toHaveBeenCalledWith(
      ['$SHELL', './workspace.sh'],
      expect.objectContaining({ cwd: '/workspace/two' }),
    )
  })
})
