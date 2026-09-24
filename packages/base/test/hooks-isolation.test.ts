import type { ExtensionAPI } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { SHELL_SENTINEL } from '../extensions/tools-core/src/tools/shell.js'
import { isolatedEcosystem } from '../src/hooks-isolation.js'
import type { HostFs, SeamInitContext } from '../src/seam-init.js'

const json = JSON.stringify({
  hooks: {
    UserPromptSubmit: [
      {
        hooks: [
          { type: 'command', command: 'printf ok' },
          { type: 'http', url: 'https://hooks.example.test/agnes' },
        ],
      },
    ],
  },
})

function fsWithConfig(path: string): HostFs {
  return {
    async realpath(candidate) {
      return candidate
    },
    async stat(candidate) {
      if (candidate !== path) throw new Error('ENOENT')
      return { kind: 'file', size: Buffer.byteLength(json), mtimeMs: 0 }
    },
    async read(candidate) {
      if (candidate !== path) throw new Error('ENOENT')
      return Buffer.from(json)
    },
    async write() {
      throw new Error('read only')
    },
    async list() {
      return []
    },
    async mkdir() {
      throw new Error('read only')
    },
    async rm() {
      throw new Error('read only')
    },
  }
}

function fixture() {
  const exec = vi.fn(async () => ({ code: 0, stdout: '{}', stderr: '', truncated: false }))
  const append = vi.fn(async () => 1)
  const init = {
    adapters: {
      dataFs: fsWithConfig('/data/hooks.json'),
      fs: fsWithConfig('.agh/hooks.json'),
    },
    profile: {
      name: 'test',
      resolvedProfileHash: 'hash',
      dataDir: '/data',
      workspaceRoot: '/workspace',
      homeDir: '/home',
      limits: {},
      preset: { sandbox: { network_allow: [] } },
    },
    sandbox: { exec },
  } as unknown as SeamInitContext
  const api = { events: { append } } as unknown as ExtensionAPI
  return { init, api, exec, append }
}

describe('hooks-runner isolated ecosystem preparation', () => {
  it('reads configuration in Host and exposes only JSON bootstrap data', async () => {
    const { init } = fixture()
    const prepared = await isolatedEcosystem['agnes/hooks-runner'](init)
    expect(prepared.data).toMatchObject({
      groups: [{ event: 'UserPromptSubmit' }],
      workspaceSnapshots: true,
      profile: {
        workspaceRoot: '/workspace',
        homeDir: '',
        limits: {},
        preset: { surface: 'unknown', locale: 'en', sandbox: { network_allow: [] } },
      },
      map: { version: expect.any(String) },
    })
    expect(JSON.parse(JSON.stringify(prepared.data))).toEqual(prepared.data)
  })

  it('validates the fixed exec and event capabilities and replaces the child signal', async () => {
    const { init, api, exec, append } = fixture()
    const prepared = await isolatedEcosystem['agnes/hooks-runner'](init)
    const signal = new AbortController().signal
    const invocation = {
      event: 'before_step',
      payload: { turn: 1, step: 2, budget: { remaining: 10, cap: 20 }, depth: 0 },
      session: { key: 's', workspaceRoot: '/workspace', turn: 1, step: 2 },
      workspaceHooks: {
        workspaceDigest: 'sha256-workspace',
        policyRevision: 'policy-1',
        hooks: [
          {
            event: 'UserPromptSubmit',
            hooks: [
              { type: 'command', command: 'printf ok' },
              { type: 'http', url: 'https://hooks.example.test/agnes' },
            ],
          },
        ],
      },
      sandbox: init.sandbox as NonNullable<SeamInitContext['sandbox']>,
    }
    const body = {
      ...invocation.payload,
      hook_event_name: 'UserPromptSubmit',
      session_id: 's',
      cwd: '/workspace',
    }
    await prepared.capability(
      api,
      'exec',
      {
        argv: [SHELL_SENTINEL, 'printf ok'],
        options: {
          cwd: '/workspace',
          env: {
            AGNES_SESSION_ID: 's',
            AGNES_STEP_ID: '1/2',
            AGNES_SURFACE: 'unknown',
            AGNES_LOCALE: 'en',
            AGNES_PRINCIPAL: 'unknown',
            AGNES_PLUGIN_ROOT: '/data',
          },
          stdin: JSON.stringify(body),
          timeoutMs: 1000,
          maxOutputBytes: 64 * 1024,
        },
      },
      signal,
      invocation,
    )
    expect(exec).toHaveBeenCalledWith(
      [SHELL_SENTINEL, 'printf ok'],
      expect.objectContaining({ cwd: '/workspace', signal }),
    )
    await prepared.capability(
      api,
      'events.append',
      { name: 'unsupported', data: { event: 'x' } },
      signal,
      invocation,
    )
    expect(append).toHaveBeenCalledWith('unsupported', { event: 'x' })
    await expect(
      prepared.capability(
        api,
        'exec',
        {
          argv: ['/bin/sh', '-c'],
          options: {
            cwd: '/workspace',
            env: {},
            stdin: '{}',
            timeoutMs: 1000,
            maxOutputBytes: 64 * 1024,
          },
        },
        signal,
        invocation,
      ),
    ).rejects.toThrow('invalid isolated exec capability')
    await expect(prepared.capability(api, 'http.resolve', {}, signal, invocation)).rejects.toThrow(
      'unknown isolated hooks-runner capability',
    )
    await expect(
      prepared.capability(
        api,
        'http.run',
        {
          spec: {
            url: 'https://hooks.example.test/agnes',
            timeoutMs: 1000,
            allowHosts: ['hooks.example.test'],
          },
          payload: { ...body, turn: 99 },
        },
        signal,
        invocation,
      ),
    ).rejects.toThrow('invalid isolated HTTP capability')
  })
})

describe('isolated exec/http re-check matcher enforcement (group-01-1)', () => {
  // Two PreToolUse groups sharing an event but scoped to different tools by matcher.
  const groups = [
    { matcher: 'Bash', command: 'echo bash-hook', url: 'https://hooks.example.test/bash' },
    { matcher: 'Write', command: 'echo write-hook', url: 'https://hooks.example.test/write' },
  ]

  function workspaceHooks(list: Array<{ matcher?: string; command: string; url: string }>) {
    return {
      workspaceDigest: 'sha256-workspace',
      policyRevision: 'policy-1',
      hooks: list.map((g) => ({
        event: 'PreToolUse',
        ...(g.matcher === undefined ? {} : { matcher: g.matcher }),
        hooks: [
          { type: 'command' as const, command: g.command },
          { type: 'http' as const, url: g.url },
        ],
      })),
    }
  }

  function toolCallInvocation(name: string, hooks: ReturnType<typeof workspaceHooks>, init: SeamInitContext) {
    const payload = { name, toolUseId: 't1', args: {} }
    const invocation = {
      event: 'tool_call',
      payload,
      session: { key: 's', workspaceRoot: '/workspace', turn: 1, step: 2 },
      workspaceHooks: hooks,
      sandbox: init.sandbox as NonNullable<SeamInitContext['sandbox']>,
    }
    const body = { ...payload, hook_event_name: 'PreToolUse', session_id: 's', cwd: '/workspace' }
    return { invocation, body }
  }

  const execOptions = (body: unknown) => ({
    cwd: '/workspace',
    env: {
      AGNES_SESSION_ID: 's',
      AGNES_STEP_ID: '1/2',
      AGNES_SURFACE: 'unknown',
      AGNES_LOCALE: 'en',
      AGNES_PRINCIPAL: 'unknown',
      AGNES_PLUGIN_ROOT: '/data',
    },
    stdin: JSON.stringify(body),
    timeoutMs: 1000,
    maxOutputBytes: 64 * 1024,
  })

  it('rejects an exec request for a sibling group whose matcher does not match the tool call', async () => {
    const { init, api } = fixture()
    const prepared = await isolatedEcosystem['agnes/hooks-runner'](init)
    const { invocation, body } = toolCallInvocation('Bash', workspaceHooks(groups), init)
    await expect(
      prepared.capability(
        api,
        'exec',
        { argv: [SHELL_SENTINEL, 'echo write-hook'], options: execOptions(body) },
        new AbortController().signal,
        invocation,
      ),
    ).rejects.toThrow('invalid isolated exec capability')
  })

  it('rejects an http request for a sibling group whose matcher does not match the tool call', async () => {
    const { init, api } = fixture()
    const prepared = await isolatedEcosystem['agnes/hooks-runner'](init)
    const { invocation, body } = toolCallInvocation('Bash', workspaceHooks(groups), init)
    await expect(
      prepared.capability(
        api,
        'http.run',
        {
          spec: { url: 'https://hooks.example.test/write', timeoutMs: 1000, allowHosts: [] },
          payload: body,
        },
        new AbortController().signal,
        invocation,
      ),
    ).rejects.toThrow('invalid isolated HTTP capability')
  })

  it('still allows exec/http for the group whose matcher matches the tool call', async () => {
    const { init, api, exec } = fixture()
    const prepared = await isolatedEcosystem['agnes/hooks-runner'](init)
    const { invocation, body } = toolCallInvocation('Bash', workspaceHooks(groups), init)
    await prepared.capability(
      api,
      'exec',
      { argv: [SHELL_SENTINEL, 'echo bash-hook'], options: execOptions(body) },
      new AbortController().signal,
      invocation,
    )
    expect(exec).toHaveBeenCalledWith(
      [SHELL_SENTINEL, 'echo bash-hook'],
      expect.objectContaining({ cwd: '/workspace' }),
    )
    // network_allow is empty in the fixture, so a matcher-cleared request fails downstream at the
    // allowlist, not at the isolated-capability re-check — proving the re-check itself let it through.
    await expect(
      prepared.capability(
        api,
        'http.run',
        {
          spec: { url: 'https://hooks.example.test/bash', timeoutMs: 1000, allowHosts: [] },
          payload: body,
        },
        new AbortController().signal,
        invocation,
      ),
    ).rejects.toThrow('E_NETWORK_DENIED')
  })

  it('leaves a matcher-less group unfiltered on a matched tool_call event', async () => {
    const { init, api, exec } = fixture()
    const prepared = await isolatedEcosystem['agnes/hooks-runner'](init)
    const hooks = workspaceHooks([{ command: 'echo global-hook', url: 'https://hooks.example.test/global' }])
    const { invocation, body } = toolCallInvocation('AnyTool', hooks, init)
    await prepared.capability(
      api,
      'exec',
      { argv: [SHELL_SENTINEL, 'echo global-hook'], options: execOptions(body) },
      new AbortController().signal,
      invocation,
    )
    expect(exec).toHaveBeenCalledWith(
      [SHELL_SENTINEL, 'echo global-hook'],
      expect.objectContaining({ cwd: '/workspace' }),
    )
  })

  it('rejects a group with an unsafe matcher even on a non-tool_call event, like the in-process bindGroups drop', async () => {
    const { init, api } = fixture()
    const prepared = await isolatedEcosystem['agnes/hooks-runner'](init)
    const payload = { turn: 1, step: 2 }
    const invocation = {
      event: 'before_step',
      payload,
      session: { key: 's', workspaceRoot: '/workspace', turn: 1, step: 2 },
      workspaceHooks: {
        workspaceDigest: 'sha256-workspace',
        policyRevision: 'policy-1',
        hooks: [
          {
            event: 'UserPromptSubmit',
            matcher: 'foo(bar',
            hooks: [{ type: 'command', command: 'echo bad' }],
          },
        ],
      },
      sandbox: init.sandbox as NonNullable<SeamInitContext['sandbox']>,
    }
    const body = { ...payload, hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/workspace' }
    await expect(
      prepared.capability(
        api,
        'exec',
        { argv: [SHELL_SENTINEL, 'echo bad'], options: execOptions(body) },
        new AbortController().signal,
        invocation,
      ),
    ).rejects.toThrow('invalid isolated exec capability')
  })
})
