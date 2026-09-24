import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapWorkerResources } from '../src/runtime-bootstrap.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

const barrier = {
  quiesce: async <T>(_operationId: string, publish: (permit: unknown) => Promise<T>): Promise<T> =>
    publish({}),
}

describe('worker stdio MCP bootstrap', () => {
  it('connects a none-bound stdio MCP through initialize and paginated tools/list without a secret resolver', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-resource-stdio-'))
    roots.push(root)
    const server = join(root, 'server.mjs')
    const snapshot = join(root, 'resource-snapshot.json')
    await writeFile(
      server,
      [
        "import readline from 'node:readline'",
        "const tool = (name) => ({ name, description: name, inputSchema: { type: 'object', properties: {}, additionalProperties: false } })",
        "const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')",
        "readline.createInterface({ input: process.stdin }).on('line', (line) => { const request = JSON.parse(line); if (request.method === 'initialize') reply(request.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }); else if (request.method === 'tools/list') { const page = request.params?.cursor === 'second' ? [tool('second')] : [tool('first')]; reply(request.id, { tools: page, ...(request.params?.cursor ? {} : { nextCursor: 'second' }) }); } else if (request.id !== undefined) reply(request.id, {}); })",
      ].join(';'),
    )
    await writeFile(
      snapshot,
      JSON.stringify({
        version: 1,
        mcpAuthority: 'resource-control',
        skills: { control: { desired: [], trust: [] } },
        mcp: [
          {
            definition: {
              serverId: 'fixture',
              displayName: 'Fixture',
              transport: { kind: 'stdio', executable: process.execPath, args: [server] },
              secretBinding: { kind: 'none' },
              toolPolicy: { allow: ['first', 'second'] },
            },
            revision: 'a'.repeat(64),
            desired: 'enabled',
            trust: 'trusted',
          },
        ],
      }),
    )
    const state = await bootstrapWorkerResources({
      env: {
        AGNES_RESOURCE_SNAPSHOT: snapshot,
        AGNES_RESOURCE_CONTROL: '1',
        AGNES_RESOURCE_MCP_POLICY: JSON.stringify({
          allowedExecutables: [process.execPath],
          allowLoopbackHttp: false,
          localDaemon: true,
        }),
      },
      cwd: root,
      // The production resolved profile has adapters; retaining this minimal legacy shape proves a
      // no-secret definition does not touch the resolver before the transport handshake.
      profile: { name: 'local-dev', dataDir: root } as never,
      createBarrier: () => barrier,
      createSecrets: () => {
        throw new Error('none-bound MCP must not create a secret resolver')
      },
    })
    try {
      expect(state?.mcp).toMatchObject([{ serverId: 'fixture', connectionState: 'ready', toolCount: 2 }])
      expect(state?.runtime.mcpResources().list()[0]?.catalog).toHaveLength(2)
      expect(
        state?.runtime
          .mcpResources()
          .list()[0]
          ?.catalog?.map((tool) => tool.name),
      ).toEqual(['first', 'second'])
    } finally {
      await state?.runtime.mcp.close()
    }
  })

  it('with mcpRows, connects nothing and hands the validated entries back for the caller to mount as rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-resource-rows-'))
    roots.push(root)
    const server = join(root, 'server.mjs')
    const started = join(root, 'started')
    const snapshot = join(root, 'resource-snapshot.json')
    // Any spawn of this server leaves a marker, so "connected nothing" is observed, not inferred.
    await writeFile(
      server,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(started)}, '1')`,
    )
    const entry = {
      definition: {
        serverId: 'fixture',
        displayName: 'Fixture',
        transport: { kind: 'stdio', executable: process.execPath, args: [server] },
        secretBinding: { kind: 'none' },
      },
      revision: 'a'.repeat(64),
      desired: 'enabled',
      trust: 'trusted',
    }
    await writeFile(
      snapshot,
      JSON.stringify({
        version: 1,
        mcpAuthority: 'resource-control',
        skills: { control: { desired: [], trust: [] } },
        mcp: [entry],
      }),
    )
    const state = await bootstrapWorkerResources({
      env: {
        AGNES_RESOURCE_SNAPSHOT: snapshot,
        AGNES_RESOURCE_MCP_POLICY: JSON.stringify({
          allowedExecutables: [process.execPath],
          allowLoopbackHttp: false,
          localDaemon: true,
        }),
      },
      cwd: root,
      profile: { name: 'local-dev', dataDir: root } as never,
      createBarrier: () => barrier,
      createSecrets: () => {
        throw new Error('mcpRows must not resolve any secret')
      },
      mcpRows: true,
    })
    try {
      expect(state?.mcp).toEqual([])
      expect(state?.runtime.mcpResources().list()).toEqual([])
      expect(state?.mcpEntries).toEqual([entry])
      expect(existsSync(started)).toBe(false)
    } finally {
      await state?.runtime.mcp.close()
    }
  })

  it('a test worker connects nothing during bootstrap, even for an already enabled and trusted server', async () => {
    // single-resident-worker design §3.4: the manager's own desired/trust-driven reconcile must not
    // also connect the tested server - resourceMcpTest (a separate wire command, not exercised by
    // this test) is this worker type's only connection, using the candidate definition it carries.
    const root = await mkdtemp(join(tmpdir(), 'agnes-resource-test-server-'))
    roots.push(root)
    const server = join(root, 'server.mjs')
    const started = join(root, 'started')
    const snapshot = join(root, 'resource-snapshot.json')
    await writeFile(
      server,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(started)}, '1')`,
    )
    await writeFile(
      snapshot,
      JSON.stringify({
        version: 1,
        mcpAuthority: 'resource-control',
        skills: { control: { desired: [], trust: [] } },
        mcp: [
          {
            definition: {
              serverId: 'fixture',
              displayName: 'Fixture',
              transport: { kind: 'stdio', executable: process.execPath, args: [server] },
              secretBinding: { kind: 'none' },
            },
            revision: 'a'.repeat(64),
            desired: 'enabled',
            trust: 'trusted',
          },
        ],
      }),
    )
    const env: NodeJS.ProcessEnv = {
      AGNES_RESOURCE_SNAPSHOT: snapshot,
      AGNES_RESOURCE_TEST_SERVER: 'fixture',
      AGNES_RESOURCE_MCP_POLICY: JSON.stringify({
        allowedExecutables: process.platform === 'win32' ? [] : [process.execPath],
        allowLoopbackHttp: false,
        localDaemon: true,
      }),
    }
    const state = await bootstrapWorkerResources({
      env,
      cwd: root,
      profile: { name: 'local-dev', dataDir: root } as never,
      createBarrier: () => barrier,
      createSecrets: () => {
        throw new Error('bootstrap must not resolve any secret for a test worker')
      },
    })
    try {
      // Staged (so test()/tools()'s verify() finds it) but never auto-connected: this worker's
      // bootstrap reconcile sees it forced to desired: 'disabled' regardless of the journal's own
      // desired state, so it reports disabled and - the actual point of this test - never spawns
      // the fixture process itself.
      expect(state?.mcp).toEqual([
        expect.objectContaining({ serverId: 'fixture', connectionState: 'disabled' }),
      ])
      if (process.platform === 'win32') expect(env.AGNES_MCP_STDIO_ALLOWLIST).toBe(process.execPath)
      expect(existsSync(started)).toBe(false)
    } finally {
      await state?.runtime.mcp.close()
    }
  })
})
