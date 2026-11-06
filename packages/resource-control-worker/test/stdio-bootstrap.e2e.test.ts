import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootstrapWorkerResources } from '../src/runtime-bootstrap.js'
import { observeMcpProcesses } from './child-process-observer.js'

const inspection = vi.hoisted(() => ({ delayMs: 0, marker: '' }))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const execute = promisify(actual.execFile)
  const script = `import {writeFile} from 'node:fs/promises'; import {setTimeout} from 'node:timers/promises'; import {execFile} from 'node:child_process'; import {promisify} from 'node:util';
await writeFile(process.argv[1],String(process.pid)); await setTimeout(Number(process.argv[2]));
const {stdout,stderr}=await promisify(execFile)('/usr/bin/otool',process.argv.slice(3)); process.stdout.write(stdout); process.stderr.write(stderr);`
  return {
    ...actual,
    execFile: new Proxy((...args: unknown[]) => Reflect.apply(actual.execFile, undefined, args), {
      get(_target, property) {
        if (property !== promisify.custom) return Reflect.get(actual.execFile, property)
        return (file: string, args: string[], options: object) =>
          file === '/usr/bin/otool' && inspection.delayMs
            ? execute(
                process.execPath,
                [
                  '--input-type=module',
                  '-e',
                  script,
                  '--',
                  inspection.marker,
                  String(inspection.delayMs),
                  ...args,
                ],
                options,
              )
            : execute(file, args, options)
      },
    }),
  }
})

const roots: string[] = []
afterEach(async () => {
  inspection.delayMs = 0
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

const barrier = {
  quiesce: async <T>(_operationId: string, publish: (permit: unknown) => Promise<T>): Promise<T> =>
    publish({}),
}

describe('worker stdio MCP bootstrap', () => {
  it('requires the trusted actual home before preparing a confined stdio process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-mcp-missing-home-'))
    roots.push(root)
    const { sandboxMcpConfig } = await import('../src/mcp-sandbox.js')
    await expect(
      sandboxMcpConfig(
        {
          id: 'fixture',
          transport: 'stdio',
          cmd: [process.execPath],
          sandboxProfile: 'strict',
          defer: false,
        },
        { dataDir: root },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'E_MCP_SANDBOX_UNAVAILABLE' })
    expect(existsSync(join(root, 'mcp'))).toBe(false)
  })

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
              ...(process.platform === 'win32' ? { sandboxProfile: 'off-with-warning' } : {}),
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
    const observer = observeMcpProcesses()
    let state: Awaited<ReturnType<typeof bootstrapWorkerResources>>
    try {
      state = await bootstrapWorkerResources({
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
        agnesHomeDir: join(root, 'home'),
        // The production resolved profile has adapters; retaining this minimal legacy shape proves a
        // no-secret definition does not touch the resolver before the transport handshake.
        profile: { name: 'local-dev', dataDir: root } as never,
        createBarrier: () => barrier,
        createSecrets: () => {
          throw new Error('none-bound MCP must not create a secret resolver')
        },
      })
      expect(state?.mcp).toMatchObject([{ serverId: 'fixture', connectionState: 'ready', toolCount: 2 }])
      expect(state?.runtime.mcpResources().list()[0]?.catalog).toHaveLength(2)
      expect(
        state?.runtime
          .mcpResources()
          .list()[0]
          ?.catalog?.map((tool) => tool.name),
      ).toEqual(['first', 'second'])
    } catch (error) {
      console.error(
        'STDIO_BOOTSTRAP_PROCESS_FAILURE',
        JSON.stringify({ events: observer.events, dropped: observer.dropped }),
      )
      throw error
    } finally {
      observer.dispose()
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

describe.skipIf(process.platform !== 'darwin')('confined stdio connection budget', () => {
  async function fixture(timeoutMs = 10_000, handshakeMs = 0) {
    const { createMcpServerOpener } = await import('../src/mcp-server-opener.js')
    const root = await mkdtemp(join(tmpdir(), 'agnes-mcp-budget-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const entry = join(root, 'mcp', 'fixture', 'entered')
    const server = join(workspace, 'server.mjs')
    await writeFile(
      server,
      String.raw`import readline from 'node:readline'; import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(entry)},String(process.pid));
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='initialize')setTimeout(()=>reply(r.id,{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'budget',version:'1'}}),${handshakeMs});else if(r.method==='tools/list')reply(r.id,{tools:[{name:'status',inputSchema:{type:'object',properties:{}}}]});else if(r.id!==undefined)reply(r.id,{})});`,
    )
    inspection.marker = join(root, 'inspection-started')
    const definition = {
      serverId: 'fixture',
      displayName: 'Fixture',
      sandboxProfile: 'strict' as const,
      workspacePath: workspace,
      transport: { kind: 'stdio' as const, executable: process.execPath, args: [server] },
      secretBinding: { kind: 'none' as const },
    }
    const opener = createMcpServerOpener({
      resolver: async () => '',
      baseEnv: {},
      stdioPolicy: { allowedExecutables: [process.execPath] },
      httpPolicy: {},
      connectTimeoutMs: timeoutMs,
      sandbox: { home: join(root, 'home'), dataDir: root },
    })
    return { root, workspace, entry, definition, opener }
  }

  it.each(['bootstrap', 'opener'])(
    'allows a real 2.5s inspection within the existing 10s %s budget',
    async (mode) => {
      const f = await fixture()
      inspection.delayMs = 2_500
      if (mode === 'opener') {
        const connection = await f.opener.connect(f.definition, new AbortController().signal)
        try {
          expect((await connection.listTools()).map((tool) => tool.name)).toEqual(['status'])
        } finally {
          await connection.close()
        }
      } else {
        const snapshot = join(f.root, 'snapshot.json')
        await writeFile(
          snapshot,
          JSON.stringify({
            version: 1,
            mcpAuthority: 'resource-control',
            skills: { control: { desired: [], trust: [] } },
            mcp: [
              { definition: f.definition, revision: 'a'.repeat(64), desired: 'enabled', trust: 'trusted' },
            ],
          }),
        )
        const state = await bootstrapWorkerResources({
          env: {
            AGNES_RESOURCE_SNAPSHOT: snapshot,
            AGNES_RESOURCE_CONTROL: '1',
            AGNES_RESOURCE_MCP_POLICY: JSON.stringify({
              allowedExecutables: [process.execPath],
              localDaemon: true,
            }),
          },
          cwd: f.workspace,
          agnesHomeDir: join(f.root, 'home'),
          profile: { name: 'local-dev', dataDir: f.root } as never,
          createBarrier: () => barrier,
          createSecrets: () => {
            throw Error('none-bound fixture')
          },
        })
        try {
          expect(state?.mcp).toMatchObject([{ connectionState: 'ready', toolCount: 1 }])
        } finally {
          await state?.runtime.mcp.close()
        }
      }
      expect(existsSync(inspection.marker)).toBe(true)
      expect(existsSync(f.entry)).toBe(true)
    },
  )

  it.each(['expiry', 'cancel'])('stops inspection on %s without starting the MCP server', async (mode) => {
    const f = await fixture(mode === 'expiry' ? 300 : 10_000)
    inspection.delayMs = 2_500
    const controller = new AbortController()
    const pending = f.opener.connect(f.definition, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject(
      mode === 'expiry' ? { code: 'MCP_CONNECT_TIMEOUT' } : { name: 'AbortError' },
    )
    await vi.waitFor(() => expect(existsSync(inspection.marker)).toBe(true))
    const pid = Number(await readFile(inspection.marker, 'utf8'))
    if (mode === 'cancel') controller.abort()
    await rejected
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow())
    expect(existsSync(f.entry)).toBe(false)
  })

  it('does not restart the budget between inspection and handshake', async () => {
    const f = await fixture(3_500, 2_000)
    inspection.delayMs = 2_500
    await expect(f.opener.connect(f.definition, new AbortController().signal)).rejects.toMatchObject({
      code: 'MCP_CONNECT_TIMEOUT',
    })
    expect(existsSync(f.entry)).toBe(true)
    const pid = Number(await readFile(f.entry, 'utf8'))
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow())
  })

  it('connects with a fresh signal after the preparation caller has cancelled', async () => {
    const f = await fixture()
    const controller = new AbortController()
    const prepared = await f.opener.prepare?.(f.definition, controller.signal)
    if (!prepared) throw Error('missing prepared configuration')
    controller.abort()
    const connection = await prepared.connect(new AbortController().signal)
    try {
      expect((await connection.listTools()).map((tool) => tool.name)).toEqual(['status'])
    } finally {
      await connection.close()
    }
  })

  it('refuses an expired prepared configuration even with a fresh connection signal', async () => {
    const f = await fixture(500)
    const prepareController = new AbortController()
    const prepared = await f.opener.prepare?.(f.definition, prepareController.signal)
    if (!prepared) throw Error('missing prepared configuration')
    prepareController.abort()
    await new Promise((resolve) => setTimeout(resolve, 550))
    await expect(
      prepared.connect(new AbortController().signal).then(async (connection) => {
        await connection.close()
        return connection
      }),
    ).rejects.toMatchObject({ code: 'MCP_CONNECT_TIMEOUT' })
    expect(existsSync(f.entry)).toBe(false)
  })
})

describe('community stdio sandbox profiles', () => {
  it.each(['strict', 'workspace-write', 'network', 'off-with-warning'] as const)(
    'enforces %s against a real MCP child',
    async (sandboxProfile) => {
      const { mkdir, readFile } = await import('node:fs/promises')
      const { createServer } = await import('node:net')
      const { createMcpServerOpener } = await import('../src/mcp-server-opener.js')
      const root = await mkdtemp(join(tmpdir(), 'agnes-mcp-sandbox-'))
      roots.push(root)
      const workspace = join(root, 'workspace'),
        syntheticHome = join(root, 'synthetic-home'),
        dataDir = join(root, 'data')
      await mkdir(workspace)
      await mkdir(join(syntheticHome, '.ssh'), { recursive: true })
      const privateFile = join(syntheticHome, '.ssh', 'fixture-key'),
        outside = join(root, 'outside.txt')
      await writeFile(privateFile, 'SYNTHETIC-KEY-NO-REAL-CREDENTIAL')
      const home = join(workspace, 'installation')
      const homeAlias = join(workspace, 'installation-alias')
      const secretsDir = join(workspace, 'configured-secrets')
      const protectedFiles = [
        join(workspace, '.agh/secrets/fixture'),
        join(home, 'secrets/fixture'),
        join(home, 'auth/fixture'),
        join(home, 'daemon/web-credential.json'),
        join(home, 'profiles/local-dev/fixture'),
        join(dataDir, 'secrets/fixture'),
        join(dataDir, 'daemon/web-credential.json'),
        join(secretsDir, 'fixture'),
      ]
      for (const file of protectedFiles) {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, 'SYNTHETIC-PROTECTED-STATE')
      }
      // Created after confinement: a missing memory tree must already be protected.
      const memoryFiles = [
        join(home, 'memory/workspaces/synthetic/MEMORY.md'),
        join(home, 'memory/user/MEMORY.md'),
      ]
      protectedFiles.push(...memoryFiles)
      await symlink(home, homeAlias, process.platform === 'win32' ? 'junction' : 'dir')
      const workspaceAlias = join(root, 'workspace-alias')
      await symlink(workspace, workspaceAlias, process.platform === 'win32' ? 'junction' : 'dir')
      protectedFiles.push(
        join(homeAlias, 'secrets/fixture'),
        join(homeAlias, 'memory/workspaces/synthetic/MEMORY.md'),
        join(workspaceAlias, '.agh/secrets/fixture'),
        join(workspaceAlias, 'installation/secrets/fixture'),
        join(workspaceAlias, 'installation/memory/user/MEMORY.md'),
      )
      const listener = createServer((socket) => socket.end())
      await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
      const address = listener.address()
      if (!address || typeof address === 'string') throw Error('listener unavailable')
      const server = join(workspace, 'server.mjs')
      await writeFile(
        server,
        `import readline from 'node:readline'; import {readFile,writeFile,stat,rename} from 'node:fs/promises'; import {connect} from 'node:net';
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
const attempt=async(fn)=>{try{await fn();return true}catch{return false}};
readline.createInterface({input:process.stdin}).on('line',async(line)=>{const r=JSON.parse(line);if(r.method==='initialize')reply(r.id,{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'sandbox-fixture',version:'1'}});else if(r.method==='tools/list')reply(r.id,{tools:[{name:'probe',description:'Synthetic boundary probe',inputSchema:{type:'object',properties:{},additionalProperties:false}}]});else if(r.method==='tools/call'){const p=r.params.arguments; const protectedRead=await Promise.all(p.protectedFiles.map(file=>attempt(()=>readFile(file)))); const memoryWrite=await Promise.all(p.memoryFiles.map(file=>attempt(()=>writeFile(file,'SYNTHETIC-MEMORY-UPDATE')))); const renamed=await attempt(()=>rename(p.home,p.renamedHome)); const protectedAfterParentChange=await Promise.all(p.homeLeaves.map(leaf=>attempt(()=>readFile((renamed?p.renamedHome:p.home)+'/'+leaf)))); const result={memoryWrite,protectedRead,protectedAfterParentChange,privateRead:await attempt(()=>readFile(p.privateFile)),privateStat:await attempt(()=>stat(p.privateFile)),outsideWrite:await attempt(()=>writeFile(p.outside,'outside')),workspaceWrite:await attempt(()=>writeFile(p.workspaceFile,'workspace')),dataWrite:await attempt(()=>writeFile(process.env.HOME+'/own-data','data')),network:await attempt(()=>new Promise((resolve,reject)=>{const socket=connect({host:'localhost',family:4,port:p.port});socket.setTimeout(1000,()=>{socket.destroy();reject(Error('timeout'))});socket.once('connect',()=>{socket.destroy();resolve()});socket.once('error',reject)}))};reply(r.id,{content:[{type:'text',text:JSON.stringify(result)}]})}else if(r.id!==undefined)reply(r.id,{})})`,
      )
      const opener = createMcpServerOpener({
        resolver: async () => '',
        baseEnv: { HOME: syntheticHome },
        stdioPolicy: { allowedExecutables: [process.execPath] },
        httpPolicy: {},
        sandbox: {
          dataDir,
          home: homeAlias,
          secretsDir,
          profileDir: join(homeAlias, 'profiles', 'local-dev'),
        },
      })
      let connection: Awaited<ReturnType<typeof opener.connect>> | undefined
      try {
        const pending = opener.connect(
          {
            serverId: 'fixture',
            displayName: 'Fixture',
            sandboxProfile,
            workspacePath: workspaceAlias,
            transport: { kind: 'stdio', executable: process.execPath, args: [server] },
            secretBinding: { kind: 'none' },
          },
          new AbortController().signal,
        )
        if (process.platform === 'win32' && sandboxProfile !== 'off-with-warning') {
          await expect(pending).rejects.toMatchObject({ code: 'E_MCP_SANDBOX_UNAVAILABLE' })
          return
        }
        connection = await pending
        for (const file of memoryFiles) {
          await mkdir(dirname(file), { recursive: true })
          await writeFile(file, 'SYNTHETIC-PRIVATE-MEMORY')
        }
        expect((await connection.listTools()).map((tool) => tool.name)).toEqual(['probe'])
        const response = await connection.callTool(
          'probe',
          {
            privateFile,
            protectedFiles,
            memoryFiles,
            home,
            renamedHome: join(workspace, 'installation-renamed'),
            homeLeaves: [
              'secrets/fixture',
              'auth/fixture',
              'profiles/local-dev/fixture',
              'memory/workspaces/synthetic/MEMORY.md',
              'memory/user/MEMORY.md',
            ],
            outside,
            workspaceFile: join(workspace, 'result.txt'),
            port: address.port,
          },
          { signal: new AbortController().signal },
        )
        const text = response.content.find((item) => item.type === 'text')
        if (!text || text.type !== 'text') throw Error('probe result missing')
        expect(JSON.parse(text.text)).toEqual({
          memoryWrite: memoryFiles.map(() => sandboxProfile === 'off-with-warning'),
          protectedRead: protectedFiles.map(() => sandboxProfile === 'off-with-warning'),
          protectedAfterParentChange: [0, 1, 2, 3, 4].map(() => sandboxProfile === 'off-with-warning'),
          privateRead: sandboxProfile === 'off-with-warning',
          privateStat: sandboxProfile === 'off-with-warning',
          outsideWrite: sandboxProfile === 'off-with-warning',
          workspaceWrite: sandboxProfile === 'workspace-write' || sandboxProfile === 'off-with-warning',
          dataWrite: true,
          network: sandboxProfile === 'network' || sandboxProfile === 'off-with-warning',
        })
        expect(existsSync(home)).toBe(sandboxProfile !== 'off-with-warning')
        expect(await readFile(privateFile, 'utf8')).toBe('SYNTHETIC-KEY-NO-REAL-CREDENTIAL')
      } finally {
        await connection?.close()
        await new Promise<void>((resolve) => listener.close(() => resolve()))
      }
    },
  )
})
