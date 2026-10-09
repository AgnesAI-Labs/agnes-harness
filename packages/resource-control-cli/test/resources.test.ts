import { createMcpPreset } from '@agnes/resource-control-contracts/mcp-presets'
import { describe, expect, it } from 'vitest'
import {
  ResourceOperationFailure,
  resourceCapabilityMissing,
  resourceOperationFailureWasRendered,
  runResourceCommand,
} from '../src/resources.js'

describe('resource CLI argument boundary', () => {
  it('only treats an explicitly unavailable method as an old-daemon compatibility case', () => {
    expect(resourceCapabilityMissing({ data: { code: 'METHOD_NOT_FOUND' } })).toBe(true)
    expect(resourceCapabilityMissing({ data: { code: 'RESOURCE_METHOD_UNAVAILABLE' } })).toBe(true)
    expect(resourceCapabilityMissing({ data: { code: 'CAPABILITY_DENIED' } })).toBe(false)
    expect(resourceCapabilityMissing({ data: { code: 'REVISION_CONFLICT' } })).toBe(false)
  })
  it('forwards --workspace-id on list and refresh and rejects a path flag', async () => {
    const calls: unknown[] = []
    const client = {
      clientId: async () => 'client',
      resources: {
        list: async (params: unknown) => {
          calls.push(params)
          return { items: [] }
        },
        operation: {
          get: async () => ({ operationId: 'op-1', state: 'succeeded' }),
        },
      },
      skills: {
        refresh: async (params: unknown) => {
          calls.push(params)
          return { operationId: 'op-1', state: 'succeeded' }
        },
      },
    }
    const id = 'a'.repeat(64)
    await runResourceCommand(
      'resources',
      ['list', '--kind', 'skill', '--workspace-id', id],
      client as never,
      {
        write: () => undefined,
      },
    )
    await runResourceCommand('skills', ['refresh', '--workspace-id', id], client as never, {
      write: () => undefined,
      confirm: async () => true,
    })
    expect(calls[0]).toMatchObject({ kind: 'skill', workspaceId: id })
    expect(calls[1]).toMatchObject({ workspaceId: id })
    await expect(
      runResourceCommand('skills', ['refresh', '--path', '/tmp/evil'], {} as never, {
        write: () => undefined,
      }),
    ).rejects.toThrow('unknown resource command flag --path')
  })
  it('prints Skill root status before list items', async () => {
    let output = ''
    const client = {
      clientId: async () => 'client',
      resources: {
        list: async () => ({
          items: [],
          skillRoots: [{ rootKey: 'workspace-agnes', scope: 'workspace', state: 'empty' }],
        }),
      },
    }
    await runResourceCommand('resources', ['list', '--kind', 'skill'], client as never, {
      write: (text) => {
        output += text
      },
    })
    expect(output).toContain('workspace/workspace-agnes empty')
    expect(output).toContain('No resources found.')
  })
  it('prints Skill lastSafeError, winner, and source on list lines', async () => {
    let output = ''
    const client = {
      clientId: async () => 'client',
      resources: {
        list: async () => ({
          items: [
            {
              kind: 'skill',
              resourceId: `skill/user/user-agnes/${'a'.repeat(64)}`,
              name: 'review',
              revision: 'b'.repeat(64),
              sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: 'a'.repeat(64) },
              priority: 400,
              resolution: { winner: true, shadowed: [] },
              trust: 'untrusted',
              desired: 'enabled',
              actual: 'unavailable',
              stale: true,
              lastSafeError: { code: 'UNTRUSTED_REVISION', message: 'trust the new revision' },
            },
          ],
        }),
      },
    }
    await runResourceCommand('resources', ['list', '--kind', 'skill'], client as never, {
      write: (text) => {
        output += text
      },
    })
    expect(output).toContain('UNTRUSTED_REVISION:trust the new revision')
    expect(output).toContain('winner')
    expect(output).toContain('source=user/user-agnes')
    expect(output).toContain('stale=true')
  })
  it('explains Skill scan templates when the resource list is empty', async () => {
    let output = ''
    const client = {
      clientId: async () => 'client',
      resources: { list: async () => ({ items: [], nextCursor: undefined }) },
    }
    await runResourceCommand('resources', ['list', '--kind', 'skill'], client as never, {
      write: (text) => {
        output += text
      },
    })
    expect(output).toContain('No resources found.')
    expect(output).toContain('<workspace>/.agh/skills/<name>/SKILL.md')
    expect(output).toContain('$AGH_HOME/skills/<name>/SKILL.md')
    expect(output).toContain('AGNES_SKILLS_IMPORT_USER=1')
    expect(output).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\/)
  })
  it('keeps the MCP empty list free of Skill path copy', async () => {
    let output = ''
    const client = {
      clientId: async () => 'client',
      resources: { list: async () => ({ items: [], nextCursor: undefined }) },
    }
    await runResourceCommand('resources', ['list', '--kind', 'mcp'], client as never, {
      write: (text) => {
        output += text
      },
    })
    expect(output).toBe('No resources found.')
  })
  it('rejects raw secret flags before it can make a Daemon call', async () => {
    await expect(
      runResourceCommand(
        'mcp',
        ['add', 'example', '--name', 'Example', '--stdio', 'example', '--env', 'TOKEN=value'],
        {} as never,
        { write: () => undefined },
      ),
    ).rejects.toThrow('secret://')
  })
  it('requires an expected revision for mutable MCP operations', async () => {
    await expect(
      runResourceCommand('mcp', ['enable', 'example'], {} as never, { write: () => undefined }),
    ).rejects.toThrow('--expected-revision')
  })
  it('tells the operator a newly created MCP server still needs trust and enable', async () => {
    let output = ''
    const client = {
      clientId: async () => 'client',
      mcp: { servers: { create: async () => ({ operationId: 'op-add', state: 'received' as const }) } },
      resources: {
        operation: {
          get: async () => ({
            operationId: 'op-add',
            kind: 'mcp.reconcile',
            state: 'succeeded' as const,
            profile: 'local-dev',
            target: 'mcp/example',
            revision: 'a'.repeat(64),
            createdAt: '2026-09-18T00:00:00.000Z',
            updatedAt: '2026-09-18T00:00:01.000Z',
            progress: 100,
          }),
        },
      },
    }
    await runResourceCommand(
      'mcp',
      ['add', 'example', '--name', 'Example', '--stdio', 'example'],
      client as never,
      {
        write: (text) => {
          output += text
        },
        confirm: async () => true,
      },
    )
    expect(output).toContain('was created but is not usable yet')
    // agh mcp trust and agh mcp enable both route through expected(), which throws UsageError without
    // --expected-revision <revision> -- the example command must include it or it cannot work.
    expect(output).toContain('agh mcp trust example --expected-revision <revision>')
    expect(output).toContain('agh mcp enable example --expected-revision <revision>')
  })
  it.each(['strict', 'workspace-write', 'network', 'off-with-warning'])(
    'accepts the explicit sandbox profile %s but rejects unknown profiles',
    async (profile) => {
      await expect(
        runResourceCommand(
          'mcp',
          ['add', 'example', '--name', 'Example', '--stdio', 'example', '--sandbox-profile', profile],
          {} as never,
          { write: () => undefined },
        ),
      ).rejects.toThrow('operation cancelled')
      await expect(
        runResourceCommand(
          'mcp',
          [
            'add',
            'example',
            '--name',
            'Example',
            '--stdio',
            'example',
            '--sandbox-profile',
            'silent-fallback',
          ],
          {} as never,
          { write: () => undefined },
        ),
      ).rejects.toThrow('--sandbox-profile requires')
    },
  )
  it('accepts normal dash-prefixed stdio arguments but rejects shell command switches', async () => {
    await expect(
      runResourceCommand(
        'mcp',
        ['add', 'example', '--name', 'Example', '--stdio', 'example', '--arg', '-y'],
        {} as never,
        { write: () => undefined },
      ),
    ).rejects.toThrow('operation cancelled')
    await expect(
      runResourceCommand(
        'mcp',
        ['add', 'example', '--name', 'Example', '--stdio', 'example', '--arg', '-c'],
        {} as never,
        { write: () => undefined },
      ),
    ).rejects.toThrow('shell command switch')
  })
  it('accepts --sse flag and creates MCP server with SSE transport', async () => {
    let capturedDefinition: unknown
    const client = {
      clientId: async () => 'client',
      mcp: {
        servers: {
          create: async (params: unknown) => {
            capturedDefinition = (params as { definition: unknown }).definition
            return { operationId: 'op-add', state: 'received' as const }
          },
        },
      },
      resources: {
        operation: {
          get: async () => ({
            operationId: 'op-add',
            kind: 'mcp.reconcile',
            state: 'succeeded' as const,
            profile: 'local-dev',
            target: 'mcp/example',
            revision: 'a'.repeat(64),
            createdAt: '2026-09-18T00:00:00.000Z',
            updatedAt: '2026-09-18T00:00:01.000Z',
            progress: 100,
          }),
        },
      },
    }
    await runResourceCommand(
      'mcp',
      ['add', 'example', '--name', 'Example', '--sse', 'https://example.com/sse'],
      client as never,
      {
        write: () => undefined,
        confirm: async () => true,
      },
    )
    expect(capturedDefinition).toMatchObject({
      transport: {
        kind: 'sse',
        url: 'https://example.com/sse',
      },
    })
  })
  it.each([
    ['resources', ['enable', 'skill/workspace/review', '--expected-revision', 'a'.repeat(64)]],
    ['skills', ['refresh']],
    ['mcp', ['test', 'example', '--expected-revision', 'a'.repeat(64)]],
  ] as const)(
    'turns terminal %s reconciliation failures into a typed safe operation failure',
    async (kind, args) => {
      let output = ''
      const operation = {
        operationId: `${kind}-failed`,
        kind: `${kind}.reconcile`,
        state: 'failed' as const,
        profile: 'local-dev',
        target: kind === 'mcp' ? 'mcp/example' : 'skill/workspace/review',
        revision: 'a'.repeat(64),
        createdAt: '2026-09-14T00:00:00.000Z',
        updatedAt: '2026-09-14T00:00:01.000Z',
        progress: 100,
        lastSafeError: { code: 'RESOURCE_RECONCILE_FAILED', message: 'Resource refresh was rejected safely' },
      }
      const receipt = async () => ({ operationId: operation.operationId, state: 'received' as const })
      const client = {
        clientId: async () => 'client',
        resources: { desiredSet: receipt, operation: { get: async () => operation } },
        skills: { refresh: receipt },
        mcp: {
          servers: {
            test: receipt,
            status: async () => ({
              lastSafeError: {
                code: 'MCP_UNAVAILABLE',
                message: 'stdio executable is not allowed by profile policy',
              },
            }),
          },
        },
      }
      await expect(
        runResourceCommand(kind, args, client as never, {
          write: (text) => {
            output += text
          },
          confirm: async () => true,
        }),
      ).rejects.toMatchObject({
        name: 'ResourceOperationFailure',
        code: 'RESOURCE_RECONCILE_FAILED',
        operationId: operation.operationId,
        outputRendered: true,
      } satisfies Partial<ResourceOperationFailure>)
      expect(output).toContain('RESOURCE_RECONCILE_FAILED: Resource refresh was rejected safely\n')
      expect(output.match(/RESOURCE_RECONCILE_FAILED/g)).toHaveLength(1)
      if (kind === 'mcp') expect(output).toContain('stdio executable is not allowed by profile policy')
      expect(
        resourceOperationFailureWasRendered(
          new ResourceOperationFailure(operation.operationId, 'failed', operation.lastSafeError, true),
        ),
      ).toBe(true)
    },
  )
})

describe('resource terminal output ownership', () => {
  it('keeps a cancelled operation terminal and renders its safe result once', async () => {
    let output = ''
    const operation = {
      operationId: 'cancel-op-1',
      kind: 'resources.operation.cancel',
      state: 'cancelled' as const,
      profile: 'local-dev',
      target: 'mcp/example',
      revision: 'a'.repeat(64),
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:01.000Z',
      progress: 100,
      lastSafeError: { code: 'RESOURCE_OPERATION_CANCELLED', message: 'Resource operation was cancelled' },
    }
    const client = {
      clientId: async () => 'client',
      resources: {
        operation: {
          cancel: async () => ({ operationId: operation.operationId, state: 'received' as const }),
          get: async () => operation,
        },
      },
    }
    await expect(
      runResourceCommand('resources', ['cancel', operation.operationId], client as never, {
        write: (text) => {
          output += text
        },
        confirm: async () => true,
      }),
    ).rejects.toMatchObject({
      state: 'cancelled',
      outputRendered: true,
    } satisfies Partial<ResourceOperationFailure>)
    expect(output).toContain('operation cancel-op-1 received\n')
    expect(output.match(/RESOURCE_OPERATION_CANCELLED/g)).toHaveLength(1)
    expect(output.endsWith('\n')).toBe(true)
  })
})

it('lists skills and accepts --yes without prompting, while preserving revision binding', async () => {
  const calls: unknown[] = []
  const client = {
    clientId: async () => 'client',
    workspace: {
      add: async (path: string) => {
        calls.push({ path })
        return { workspace: { workspaceId: 'a'.repeat(64) } }
      },
    },
    resources: {
      list: async (params: unknown) => {
        calls.push(params)
        return { items: [] }
      },
      operation: { get: async () => ({ state: 'succeeded' }) },
    },
    skills: {
      refresh: async (params: unknown) => {
        calls.push(params)
        return { operationId: 'op', state: 'received' }
      },
    },
  }
  const io = {
    workspacePath: '/project',
    write: () => undefined,
    confirm: async () => {
      throw new Error('must not prompt')
    },
  }
  await runResourceCommand('skills', ['--profile', 'local-dev', 'list'], client as never, io)
  await runResourceCommand('skills', ['refresh', '--yes'], client as never, io)
  expect(calls).toEqual([
    { path: '/project' },
    expect.objectContaining({ kind: 'skill', workspaceId: 'a'.repeat(64) }),
    { path: '/project' },
    expect.objectContaining({ profile: 'local-dev', clientId: 'client', workspaceId: 'a'.repeat(64) }),
  ])
})

it('creates the same managed Playwright preset only after explicit confirmation', async () => {
  const definitions: unknown[] = []
  let output = ''
  const client = {
    clientId: async () => 'preset-client',
    mcp: {
      servers: {
        create: async (params: { definition: unknown }) => {
          definitions.push(params.definition)
          return { operationId: 'preset-add', state: 'succeeded' }
        },
      },
    },
    resources: {
      operation: {
        get: async () => ({ operationId: 'preset-add', state: 'succeeded', revision: 'a'.repeat(64) }),
      },
    },
  }
  await expect(
    runResourceCommand('mcp', ['add', '--preset', 'playwright'], client as never, { write: () => undefined }),
  ).rejects.toThrow('operation cancelled')
  expect(definitions).toEqual([])
  await runResourceCommand('mcp', ['add', '--preset', 'playwright', '--yes'], client as never, {
    write: (text) => {
      output += text
    },
  })
  expect(definitions).toEqual([createMcpPreset('playwright')])
  expect(output).toContain('trust=untrusted, desired=disabled')
  await runResourceCommand(
    'mcp',
    ['add', 'billing', '--preset', 'playwright', '--sandbox-workspace', '/workspace/billing', '--yes'],
    client as never,
    { write: () => undefined },
  )
  expect(definitions[1]).toEqual(
    createMcpPreset('playwright', { serverId: 'billing', workspacePath: '/workspace/billing' }),
  )
  await expect(
    runResourceCommand('mcp', ['add', '--preset', 'unknown', '--yes'], client as never, {
      write: () => undefined,
    }),
  ).rejects.toThrow('Unknown MCP preset')
  await expect(
    runResourceCommand(
      'mcp',
      ['add', '--preset', 'playwright', '--stdio', 'node', '--yes'],
      client as never,
      { write: () => undefined },
    ),
  ).rejects.toThrow('--stdio does not apply')
  expect(definitions).toHaveLength(2)
})
