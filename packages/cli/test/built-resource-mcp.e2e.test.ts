import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDaemonDiscovery, resolveDaemonScope } from '@agnes/daemon'
import { createClient, memoryJournal } from '@agnes/sdk'
import { windowsEnsurePrivateDirectorySync } from '@agnes/system-node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setupMcpLegacySentinel } from './built-resource-mcp-legacy.js'
import { mcpChatProvider } from './built-resource-mcp-provider.js'
import { ownedWindowsBuild } from './owned-build.js'

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let localCli: string
let buildRoot: string | undefined
let buildSafeToRemove = true
let buildPending: Promise<CommandResult> | undefined
// Desktop test shells can launch Vitest under an older Node while pnpm exposes the project's pinned runtime.
const nodePath = process.env.npm_node_execpath ?? process.execPath
const windows = process.platform === 'win32' // guards-allow-platform: real terminal and build launcher selection.
const consoleDriver = resolve(packageDirectory, '../../tools/test-fixtures/windows-console.py')
const temporary: Array<{ directory: string; safeToRemove: () => boolean }> = []
const providerCredential = ['synthetic', 'mcp', 'chat', 'provider'].join('-')

const require = createRequire(import.meta.url)
const baseEntry = require.resolve('@agnes/base')
const baseRequire = createRequire(join(dirname(dirname(baseEntry)), 'package.json'))
const sdkPaths = {
  server: baseRequire.resolve('@modelcontextprotocol/sdk/server/index.js'),
  stdio: baseRequire.resolve('@modelcontextprotocol/sdk/server/stdio.js'),
  types: baseRequire.resolve('@modelcontextprotocol/sdk/types.js'),
}

const ptyProgram = [
  'import os, pty, select, sys, time',
  'pid, fd = pty.fork()',
  'if pid == 0: os.execvpe(sys.argv[1], sys.argv[1:], os.environ)',
  "output = b''; confirmed = False; deadline = time.monotonic() + 45",
  'while time.monotonic() < deadline:',
  '  ready, _, _ = select.select([fd], [], [], 0.2)',
  '  if ready:',
  '    try: data = os.read(fd, 4096)',
  "    except OSError: data = b''",
  '    output += data',
  "    if not confirmed and b'Continue? [y/N]' in output:",
  "      os.write(fd, b'y\\n'); confirmed = True",
  '  done, status = os.waitpid(pid, os.WNOHANG)',
  '  if done:',
  '    sys.stdout.buffer.write(output); sys.exit(os.waitstatus_to_exitcode(status))',
  'os.kill(pid, 15); _, status = os.waitpid(pid, 0)',
  'sys.stdout.buffer.write(output); sys.exit(124)',
].join('\n')

type CommandResult = Readonly<{ code: number; output: string }>

function command(
  program: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(program, [...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk))
    const timeout = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      resolveCommand({ code: code ?? 1, output: Buffer.concat(chunks).toString('utf8') })
    })
  })
}

async function invoke(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  interactive = false,
): Promise<CommandResult> {
  if (interactive && windows)
    return command(
      process.env.AGNES_TEST_PYTHON ?? 'python',
      ['-I', '-X', 'utf8', consoleDriver, '--expect', 'Continue? [y/N]', '--', nodePath, localCli, ...args],
      cwd,
      env,
    )
  return interactive
    ? command('python3', ['-c', ptyProgram, nodePath, localCli, ...args], cwd, env)
    : command(nodePath, [localCli, ...args], cwd, env)
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function officialPagedServer(directory: string): Promise<string> {
  const server = join(directory, 'official-paged-mcp.mjs')
  await writeFile(
    server,
    [
      "import { createRequire } from 'node:module'",
      'const require = createRequire(import.meta.url)',
      `const { Server } = require(${JSON.stringify(sdkPaths.server)})`,
      `const { StdioServerTransport } = require(${JSON.stringify(sdkPaths.stdio)})`,
      `const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(sdkPaths.types)})`,
      "const tools = Array.from({ length: 120 }, (_, i) => ({ name: 'tool' + String(i + 1).padStart(3, '0'), description: 'Fixture tool ' + (i + 1), inputSchema: { type: 'object', properties: { marker: { type: 'string' }, behavior: { type: 'string', enum: ['ok', 'fail', 'disconnect', 'hang'] } }, required: ['marker', 'behavior'], additionalProperties: false } }))",
      "const server = new Server({ name: 'built-cli-pager', version: '1.0.0' }, { capabilities: { tools: {} } })",
      "server.setRequestHandler(ListToolsRequestSchema, async (request) => { const start = request.params?.cursor === '100' ? 100 : 0; return { tools: tools.slice(start, start + 100), ...(start === 0 ? { nextCursor: '100' } : {}) } })",
      `const { appendFileSync } = require('node:fs')`,
      `appendFileSync(${JSON.stringify(join(directory, 'starts.jsonl'))}, JSON.stringify({ pid: process.pid, parentPid: process.ppid }) + '\\n')`,
      `server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const { marker, behavior } = request.params.arguments;
        appendFileSync(${JSON.stringify(join(directory, 'calls.jsonl'))}, JSON.stringify({ pid: process.pid, parentPid: process.ppid, name: request.params.name, marker, behavior }) + '\\n');
        if (behavior === 'disconnect') { process.exit(0); }
        if (behavior === 'hang') await new Promise((resolve) => extra.signal.addEventListener('abort', resolve, { once: true }));
        return { content: [{ type: 'text', text: (behavior === 'fail' ? 'MCP_FAILURE_' : 'MCP_RESULT_') + marker }], ...(behavior === 'fail' ? { isError: true } : {}) }
      })`,
      'await server.connect(new StdioServerTransport())',
    ].join('\n'),
    'utf8',
  )
  return server
}

async function revision(home: string, serverId = 'pager'): Promise<string> {
  const journal = JSON.parse(
    await readFile(join(home, 'data', 'resource-control', 'mcp', 'local-dev.mcp.json'), 'utf8'),
  ) as {
    servers: Record<string, { revision: string }>
  }
  const current = journal.servers[serverId]
  if (!current) throw new Error(`missing revision for ${serverId}`)
  return current.revision
}

beforeAll(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), 'agnes-mcp-build-'))
  const output = join(buildRoot, 'local')
  localCli = join(output, 'agnes.mjs')
  buildPending = (windows ? ownedWindowsBuild : command)(
    nodePath,
    ['--import', 'tsx', 'tools/build-local.ts', '--output-dir', output],
    packageDirectory,
    process.env,
  )
  const built = await buildPending
  expect(built.code, built.output).toBe(0)
}, 120_000) // The isolated full build has a 90-second command deadline; allow it to settle first.

afterAll(async () => {
  // A hook failure must not remove output while the compiler still owns it.
  await buildPending?.catch(() => undefined)
  if (buildRoot && buildSafeToRemove) await rm(buildRoot, { recursive: true, force: true })
})

afterEach(async () => {
  for (const entry of temporary.splice(0)) {
    if (!entry.safeToRemove()) {
      buildSafeToRemove = false
      throw new Error('refusing to remove a directory still used by a child process')
    }
    await rm(entry.directory, { recursive: true, force: true })
  }
})

describe('built CLI managed MCP lifecycle', () => {
  it('uses the daemon path with PTY consent and preserves a paginated official SDK catalog', async () => {
    // macOS tmpdir() can exceed the Unix socket path limit after adding the daemon layout.
    const root = await mkdtemp(join(windows ? tmpdir() : '/tmp', 'agnes-built-resource-mcp-'))
    const daemonPids = new Set<number>()
    temporary.push({
      directory: root,
      safeToRemove: () => [...daemonPids].every((pid) => !processAlive(pid)),
    })
    const home = join(root, 'home')
    const workspace = join(root, 'workspace')
    if (!windows) {
      for (const name of ['agnesd.sock', 'workers.sock'])
        expect(Buffer.byteLength(join(home, 'data', 'daemon', name))).toBeLessThanOrEqual(103)
    }
    if (windows) windowsEnsurePrivateDirectorySync(home)
    else await mkdir(home, { mode: 0o700 })
    await mkdir(workspace)
    const server = await officialPagedServer(root)
    const managedExecutable = windows ? join(root, 'managed-node.exe') : nodePath
    if (windows) await copyFile(nodePath, managedExecutable)
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST_') && name !== 'NODE_OPTIONS'),
    ) as NodeJS.ProcessEnv
    env.AGH_HOME = home
    // The legacy preset keeps its deployment grant; this new path must be granted by MCP enable.
    env.AGNES_MCP_STDIO_ALLOWLIST = nodePath
    const legacy = await setupMcpLegacySentinel({ home, workspace, nodePath })
    const legacyStarts = async () =>
      (await readFile(legacy.startsPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
    const tools = Array.from({ length: 120 }, (_, index) => `tool${String(index + 1).padStart(3, '0')}`)
    const recordDaemon = async () => {
      const owner = JSON.parse(await readFile(join(home, 'data', 'daemon', 'owner.json'), 'utf8'))
      daemonPids.add(owner.pid)
      return owner.pid as number
    }
    const cleanup = async () => {
      await recordDaemon().catch(() => undefined)
      const stopped = await invoke(['daemon', 'stop'], workspace, env)
      const starts = (await readFile(join(root, 'starts.jsonl'), 'utf8').catch(() => ''))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { pid: number; parentPid: number })
      const pids = [...new Set([...daemonPids, ...starts.flatMap((entry) => [entry.pid, entry.parentPid])])]
      for (const pid of pids) daemonPids.add(pid)
      try {
        expect(stopped.code, stopped.output).toBe(0)
        await expect.poll(() => pids.filter(processAlive), { timeout: 10_000 }).toEqual([])
      } catch (error) {
        for (const pid of pids.filter(processAlive)) process.kill(pid, 'SIGKILL')
        await expect.poll(() => pids.filter(processAlive), { timeout: 5_000 }).toEqual([])
        throw error
      }
      console.info('MCP_PROCESS_CLEANUP', JSON.stringify({ pids, alive: pids.filter(processAlive) }))
    }
    await mkdir(join(home, 'data', 'daemon'), { recursive: true, mode: 0o700 })
    let daemonLog = ''
    const daemon = spawn(
      nodePath,
      [
        join(dirname(localCli), 'daemon.mjs'),
        '--home',
        home,
        '--workspace',
        workspace,
        '--data-dir',
        join(home, 'data'),
        '--local-web-addr',
        '127.0.0.1:0',
        '--local-web-origin',
        'http://127.0.0.1:4177',
      ],
      { env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )
    if (daemon.pid !== undefined) daemonPids.add(daemon.pid)
    daemon.stdout.on('data', (chunk) => {
      daemonLog += String(chunk)
    })
    daemon.stderr.on('data', (chunk) => {
      daemonLog += String(chunk)
    })
    try {
      await expect.poll(() => daemonLog.includes('agnesd listening'), { timeout: 15_000 }).toBe(true)
      const added = await invoke(
        [
          'mcp',
          'add',
          'pager',
          '--name',
          'Pager',
          '--stdio',
          managedExecutable,
          '--arg',
          server,
          ...tools.flatMap((tool) => ['--allow-tool', tool]),
        ],
        workspace,
        env,
        true,
      )
      expect(added.code, added.output).toBe(0)
      expect(added.output).toContain('mcp.servers.create succeeded')
      expect(added.output).not.toContain(providerCredential)
      expect(added.output).not.toContain(home)
      expect(added.output).not.toMatch(/(?:Error:|\bat\s+file:)/)

      let expectedRevision = await revision(home)
      await recordDaemon()
      const trust = ['mcp', 'trust', 'pager', 'trusted', '--expected-revision', expectedRevision]
      const enable = ['mcp', 'enable', 'pager', '--expected-revision', expectedRevision]
      const test = ['mcp', 'test', 'pager', '--expected-revision', expectedRevision]
      for (const args of windows ? [trust, enable, test] : [trust, test, enable]) {
        const result = await invoke(args, workspace, env, true)
        expect(result.code, result.output).toBe(0)
        expect(result.output).toContain('succeeded')
        expect(result.output).not.toContain(providerCredential)
        expect(result.output).not.toContain(home)
        expect(result.output).not.toMatch(/(?:Error:|\bat\s+file:)/)
        if (args[1] === 'test') expect(result.output).toContain('toolCount=120')
      }

      const status = await invoke(['mcp', 'status', 'pager'], workspace, env)
      expect(status.code, status.output).toBe(0)
      expect(status.output).toContain('connection=ready')
      expect(status.output).toContain('tools=120')

      const first = await invoke(['mcp', 'tools', 'pager'], workspace, env)
      expect(first.code, first.output).toBe(0)
      expect(first.output.match(/^tool/gm)).toHaveLength(100)
      expect(first.output).toContain('nextCursor 100')
      const second = await invoke(['mcp', 'tools', 'pager', '--cursor', '100'], workspace, env)
      expect(second.code, second.output).toBe(0)
      expect(second.output.match(/^tool/gm)).toHaveLength(20)
      expect(second.output).toContain('tool120')

      const upstream = await mcpChatProvider()
      const connect = async () => {
        const scope = await resolveDaemonScope({ home, workspace, dataDir: join(home, 'data'), env })
        const discovery = await readDaemonDiscovery(scope)
        if (!discovery) throw new Error('MCP fixture daemon discovery missing')
        return createClient({
          journal: memoryJournal(),
          auth: { kind: 'local' },
          transport: {
            kind: 'unix',
            path: discovery.socketPath,
            ...(discovery.socketPath.startsWith('\\\\.\\pipe\\')
              ? {
                  serverIdentity: {
                    pid: discovery.owner.pid,
                    processStartId: discovery.owner.processStartId,
                  },
                }
              : {}),
          },
        })
      }
      let client = await connect()
      await client.workspace.add(workspace)
      const calls = async (): Promise<
        Array<{ pid: number; parentPid: number; name: string; marker: string; behavior: string }>
      > =>
        (await readFile(join(root, 'calls.jsonl'), 'utf8').catch(() => ''))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      const chat = async (marker: string, behavior = 'ok', expected = 'VERIFIED', sessionId?: string) => {
        const session = sessionId
          ? await client.session.load(sessionId, {
              cwd: workspace,
              onPermissionRequest: async () => ({ verdict: 'allowed-once' }),
            })
          : await client.session.new({ cwd: workspace })
        session.onPermissionRequest(async () => ({ verdict: 'allowed-once' }))
        const result = await session.prompt(`MC_CASE:${marker}:${behavior}`)
        expect(
          result.reason,
          JSON.stringify(upstream.observations.filter((item) => item.marker === marker)),
        ).toBe('completed')
        const timeline = JSON.stringify(await session.projectUI(undefined, { surface: 'web' }))
        expect(
          timeline,
          JSON.stringify(upstream.observations.filter((item) => item.marker === marker)),
        ).toContain(`${expected}_${marker}`)
        expect(timeline).not.toContain(providerCredential)
        const matching = (await calls()).filter((call) => call.marker === marker)
        expect(matching).toHaveLength(expected === 'ABSENT' ? 0 : 1)
        if (expected !== 'ABSENT') expect(matching[0]).toMatchObject({ name: 'tool120', marker, behavior })
        console.info(
          'MCP_CHAT_CASE',
          JSON.stringify({ marker, sessionId: session.id, expected, calls: matching }),
        )
        return session
      }
      const control = async (action: string) => {
        const result = await invoke(
          ['mcp', action, 'pager', '--expected-revision', expectedRevision],
          workspace,
          env,
          true,
        )
        expect(result.code, result.output).toBe(0)
        expect(result.output).toContain('succeeded')
      }
      try {
        const config = await client.config.get()
        const savedConfig = await client.config.save({
          providerId: 'deepseek',
          baseUrl: upstream.baseUrl,
          apiKey: providerCredential,
          model: 'deepseek-flash',
          expectedRevision: config.revision,
        })
        expect(savedConfig.effect).toBe('new-sessions')
        expect(JSON.stringify({ savedConfig, currentConfig: await client.config.get() })).not.toContain(
          providerCredential,
        )
        const firstSession = await chat('first')
        expect(await calls()).toMatchObject([{ name: 'tool120', marker: 'first', behavior: 'ok' }])
        expect(upstream.observations.some((body) => body.result.includes('MCP_RESULT_first'))).toBe(true)
        await chat('remoteFailure', 'fail', 'FAILED')
        const cancelSession = await client.session.new({ cwd: workspace })
        cancelSession.onPermissionRequest(async () => ({ verdict: 'allowed-once' }))
        const cancelled = cancelSession.prompt('MC_CASE:cancelled:hang')
        await expect
          .poll(async () => (await calls()).filter((call) => call.marker === 'cancelled').length, {
            timeout: 15_000,
          })
          .toBe(1)
        await cancelSession.cancel()
        expect((await cancelled).reason).toBe('aborted')
        await chat('afterCancel', 'ok', 'VERIFIED', cancelSession.id)

        const disconnected = await chat('lostConnection', 'disconnect', 'UNAVAILABLE')
        const disconnectedWorker = (await calls()).at(-1)
        expect(disconnectedWorker).toBeDefined()
        if (!disconnectedWorker) throw new Error('missing disconnected worker evidence')
        await control('reconnect')
        // resource-live-reload Task 7: a session whose lightweight `resource.stale` notice delivers
        // successfully no longer has its worker process killed/respawned - the pre-existing
        // registry.retireForResourceSnapshot() heavyweight fallback (this test's old assertion here
        // was written against its unconditional "retire every live session" behavior) now only
        // retires sessions whose notice failed to deliver (see packages/daemon/src/supervisor/
        // supervisor.ts's wireResourceSnapshotNotifications()). `disconnectedWorker` is idle and its
        // notice delivers, so it survives; it reloads its MCP resources in-place before its next
        // turn. Give the daemon's fire-and-forget notify-then-maybe-retire chain time to settle
        // (bounded above by notify.ts's own per-worker RESOURCE_STALE_NOTIFY_TIMEOUT_MS = 2s, times
        // however many sessions are still live at this point in the test) before asserting it did
        // *not* transition to dead - a real crash/rotation is exercised deliberately below via SIGTERM.
        await new Promise((resolve) => setTimeout(resolve, 5_000))
        expect(processAlive(disconnectedWorker.parentPid)).toBe(true)
        // resource-live-reload Task 8: this line used to be a documented KNOWN FAILURE (Task 7
        // review found it, not introduced by it - see task-7-report.md). Before Task 7, this exact
        // worker was always killed and respawned fresh above, so its in-place reload path
        // (assemble.ts's `findBundledExtension`, added by Task 3 of this same plan) was never
        // actually exercised against a real *built* (tools/build-local.ts) worker.mjs - only against
        // dev-mode `createTestHost`. Once the worker started surviving and reloading in place, the
        // daemon log showed `reloadEcosystemExtension` throwing `E_EXT_LOAD: agnes/mcp-client is not
        // a reloadable bundled ecosystem extension`: `findBundledExtension`'s real-filesystem
        // directory scan (readBundledExtensionDirs / readAuthorManifest) never accounted for the
        // packaged/built runtime's own parallel, inlined-manifest extension-loading path
        // (packages/cli/launch/packaged-host.ts's `AGNES_BASE_EXTENSION_MANIFESTS` /
        // `module.embeddedExtensions`, consumed by assemble.ts's boot-time embeddedExtensions loop
        // but not by `findBundledExtension`). Task 8 closed that gap by giving
        // `findBundledExtension` a second lookup path against the same `modules` embeddedExtensions
        // source, and routing the embedded case through `managed.loadEmbedded` with a
        // fresh-resource-bound factory selector (assemble.ts's `findBundledExtension` /
        // `reloadEcosystemExtension`). This chat call now proceeds against the reconnected MCP
        // connection and genuinely completes VERIFIED, on a real built worker.mjs.
        const recovered = await chat('reconnected', 'ok', 'VERIFIED', disconnected.id)
        // Same worker process, no restart: the reconnected MCP server was picked up by an in-place
        // resource reload, not by re-acquiring a fresh worker for this session key.
        expect((await calls()).at(-1)?.parentPid).toBe(disconnectedWorker.parentPid)
        const beforeRestart = (await calls()).at(-1)
        expect(beforeRestart).toBeDefined()
        if (!beforeRestart) throw new Error('missing worker call evidence')
        process.kill(beforeRestart.parentPid, 'SIGTERM')
        await expect.poll(() => processAlive(beforeRestart.parentPid)).toBe(false)
        // A crashed writer retains the default 30-second ledger lease. Respect its expiry;
        // never rewrite the claim or shorten production fencing merely to speed up this test.
        await new Promise((resolve) => setTimeout(resolve, 30_050))
        await chat('newWorker', 'ok', 'VERIFIED', recovered.id)
        expect((await calls()).at(-1)?.parentPid).not.toBe(beforeRestart?.parentPid)
        const oldDaemon = await recordDaemon()
        await client.close()
        expect((await invoke(['daemon', 'stop'], workspace, env)).code).toBe(0)
        await expect.poll(() => processAlive(oldDaemon)).toBe(false)
        expect((await invoke(['mcp', 'status', 'pager'], workspace, env)).code).toBe(0)
        client = await connect()
        expect(await recordDaemon()).not.toBe(oldDaemon)
        await chat('daemonRestart', 'ok', 'VERIFIED', recovered.id)
        await control('disable')
        const count = (await calls()).length
        await chat('disabled', 'ok', 'ABSENT', firstSession.id)
        expect(await calls()).toHaveLength(count)
        await client.close()
        expect((await invoke(['daemon', 'stop'], workspace, env)).code).toBe(0)
        expect((await invoke(['mcp', 'status', 'pager'], workspace, env)).code).toBe(0)
        client = await connect()
        await recordDaemon()
        await chat('disabledRestart', 'ok', 'ABSENT')
        expect(await calls()).toHaveLength(count)
        await control('remove')
        await chat('deletedEmpty', 'ok', 'ABSENT')
        expect(await calls()).toHaveLength(count)
        expect(await legacyStarts()).toEqual([])
        const neverTrusted = await invoke(
          [
            'mcp',
            'add',
            'pager',
            '--name',
            'Pager',
            '--stdio',
            nodePath,
            '--arg',
            server,
            ...tools.flatMap((tool) => ['--allow-tool', tool]),
          ],
          workspace,
          env,
          true,
        )
        expect(neverTrusted.code, neverTrusted.output).toBe(0)
        expect(neverTrusted.output).not.toContain(providerCredential)
        // Recreating the server with a different executable changes its definition revision on Windows.
        expectedRevision = await revision(home)
        const enableNeverTrusted = await invoke(
          ['mcp', 'enable', 'pager', '--expected-revision', expectedRevision],
          workspace,
          env,
          true,
        )
        expect(enableNeverTrusted.code, enableNeverTrusted.output).not.toBe(0)
        expect(enableNeverTrusted.output).toContain('MCP_RECONCILE_FAILED')
        await chat('neverTrusted', 'ok', 'ABSENT')
        expect(await calls()).toHaveLength(count)
        await control('disable')
        const untrusted = await invoke(
          ['mcp', 'trust', 'pager', 'rejected', '--expected-revision', expectedRevision],
          workspace,
          env,
          true,
        )
        expect(untrusted.code, untrusted.output).toBe(0)
        const enableUntrusted = await invoke(
          ['mcp', 'enable', 'pager', '--expected-revision', expectedRevision],
          workspace,
          env,
          true,
        )
        expect(enableUntrusted.code, enableUntrusted.output).not.toBe(0)
        expect(enableUntrusted.output).toContain('MCP_RECONCILE_FAILED')
        await chat('untrusted', 'ok', 'ABSENT')
        expect(await calls()).toHaveLength(count)
        // A failed enable still records the requested desired state. Return it to disabled and
        // wait for that operation before exercising the store's safe removal precondition.
        await control('disable')
        await control('remove')
        await chat('deletedEmptyFinal', 'ok', 'ABSENT')
        expect(await calls()).toHaveLength(count)
        expect(await legacyStarts()).toEqual([])
        console.info(
          'MCP_PACKAGED_CHAT_EVIDENCE',
          JSON.stringify({
            calls: await calls(),
            daemonPids: [...daemonPids],
            artifacts: await Promise.all(
              ['agnes.mjs', 'daemon.mjs', 'worker.mjs'].map(async (name) => ({
                name,
                sha256: createHash('sha256')
                  .update(await readFile(join(dirname(localCli), name)))
                  .digest('hex'),
              })),
            ),
            cases: [...new Set(upstream.observations.map((item) => item.marker))],
            returned: upstream.observations
              .filter((item) => item.result.includes('MCP_RESULT_'))
              .map((item) => item.marker),
          }),
        )
      } finally {
        await client.close()
        await upstream.close()
      }

      const listed = await invoke(['mcp', 'list'], workspace, env)
      expect(listed.code, listed.output).toBe(0)
      expect(listed.output).toContain('No MCP servers found.')
    } finally {
      await cleanup()
      expect(daemonLog).not.toContain(providerCredential)
      console.info('MCP_DAEMON_LOG', daemonLog)
    }
  }, 300_000)
})
