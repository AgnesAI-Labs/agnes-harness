import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { unixConnectTarget } from '../../packages/cli/src/boot/connect.js'
import { ExitCode } from '../../packages/cli/src/errors.js'
import { probePowerShell } from '../../packages/host/src/adapters/powershell.js'
import { powerShellCommand } from '../../packages/host/src/adapters/powershell-command.js'
import { createClient, memoryJournal, wsTransport } from '../../packages/sdk/src/index.node.js'
import { hasPrivateDaclSync } from '../../packages/system-node/src/index.js'
import { startProviderFixture } from './provider-fixture.js'

const entry = process.env.AGNES_LOCAL_CLI
const node = process.env.AGNES_LOCAL_NODE ?? process.execPath

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  await new Promise<void>((done) => server.close(() => done()))
  return address.port
}

async function exitChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((done) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.once('exit', () => {
      clearTimeout(timer)
      done()
    })
    child.kill('SIGTERM')
  })
}

it.skipIf(!entry)(
  'built CLI and Web share settings/history through client exit, restart and distribution-directory switching',
  async () => {
    if (!entry) throw new Error('AGNES_LOCAL_CLI must point to the built command')
    const timings: Array<{ operation: string; ms: number; stdoutEnded?: boolean; stderrEnded?: boolean }> = []
    const probeStarted = performance.now()
    const outerShell = process.env.AGNES_ACCEPTANCE_POWERSHELL
      ? await probePowerShell(process.env.AGNES_ACCEPTANCE_POWERSHELL)
      : undefined
    if (outerShell) console.info(`Acceptance outer PowerShell ${outerShell.version} (${outerShell.edition})`)
    timings.push({ operation: 'probe', ms: Math.round(performance.now() - probeStarted) })
    const root = await mkdtemp(join(tmpdir(), 'al-中文 空格-'))
    const portableRoot = join(root, 'relocated-runtime')
    const copyStarted = performance.now()
    await cp(dirname(resolve(entry)), portableRoot, { recursive: true })
    timings.push({ operation: 'copy-runtime', ms: Math.round(performance.now() - copyStarted) })
    let localEntry = join(portableRoot, 'agnes.mjs')
    const home = join(root, 'home')
    const cwd = join(root, 'foreign-workspace')
    await mkdir(cwd)
    const port = await freePort()
    const origin = `http://127.0.0.1:${port}`
    const env = {
      ...process.env,
      HOME: home,
      AGH_HOME: home,
      AGNES_PROFILE: 'local-dev',
      AGNES_WEB_ORIGIN: origin,
    }
    const command = (args: string[], workdir = cwd, commandEnv = env, commandEntry = localEntry) =>
      new Promise<{ stdout: string; stderr: string }>((done, reject) => {
        const started = performance.now()
        const child = execFile(
          outerShell?.path ?? node,
          outerShell
            ? powerShellCommand(
                outerShell,
                `& ${[node, commandEntry, ...args].map((value) => `'${value.replaceAll("'", "''")}'`).join(' ')}\nexit $LASTEXITCODE`,
              ).slice(1)
            : [commandEntry, ...args],
          { cwd: workdir, env: commandEnv, timeout: 60_000, maxBuffer: 1024 * 1024 },
          (error, stdout, stderr) => {
            const stdoutEnded = child.stdout?.readableEnded === true
            const stderrEnded = child.stderr?.readableEnded === true
            timings.push({
              operation: args[0] ?? 'cli',
              ms: Math.round(performance.now() - started),
              stdoutEnded,
              stderrEnded,
            })
            if (error) reject(error)
            else if (!stdoutEnded || !stderrEnded)
              reject(new Error('CLI capture closed before output reached EOF'))
            else done({ stdout, stderr })
          },
        )
        // Print mode consumes redirected input before sending the prompt. This caller has none.
        child.stdin?.end()
      })
    const editedFile = join(cwd, '中文 编辑.txt')
    await writeFile(editedFile, 'before', 'utf8')
    const provider = await startProviderFixture('Shared backend acceptance reply. 中文验证通过。', {
      name: 'edit',
      args: { path: editedFile, edits: [{ oldText: 'before', newText: 'after 中文' }] },
    })
    const clients: ReturnType<typeof createClient>[] = []
    let web: ChildProcess | undefined
    try {
      // Independent processes, not Promise calls to a mocked launch function.
      const listings = await Promise.allSettled(
        Array.from({ length: 5 }, () => command(['sessions', '--json'])),
      )
      // Let every process settle before cleanup, including when one launcher fails.
      for (const listing of listings) {
        if (listing.status === 'rejected') throw listing.reason
        expect(JSON.parse(listing.value.stdout).items).toEqual([])
      }
      expect((await command(['consent', 'LOCAL'])).stdout).toContain('LOCAL')
      const consentFile = join(home, 'profiles', 'local-dev', 'consent.yaml')
      expect(await readFile(consentFile, 'utf8')).toBe('telemetry:\n  consent: LOCAL\n')
      // guards-allow-platform: verify the production CLI's actual consent file ACL.
      if (process.platform === 'win32') expect(hasPrivateDaclSync(consentFile)).toBe(true)
      const ownerFile = join(home, 'data', 'daemon', 'owner.json')
      const owner = JSON.parse(await readFile(ownerFile, 'utf8')) as {
        pid: number
        processStartId: string
        generation: string
        socketPath: string
      }
      const secondWorkspace = join(root, 'another-workspace')
      await mkdir(secondWorkspace)
      await command(['sessions', '--json'], secondWorkspace)
      expect(JSON.parse(await readFile(ownerFile, 'utf8')).generation).toBe(owner.generation)
      const manual = await command(['sessions', '--json', '--connect', unixConnectTarget(owner.socketPath)])
      expect(JSON.parse(manual.stdout).items).toEqual([])
      await expect(
        command([
          'sessions',
          '--connect',
          unixConnectTarget(
            owner.socketPath.startsWith('\\\\.\\pipe\\')
              ? `${owner.socketPath}-missing`
              : join(root, 'missing.sock'),
          ),
        ]),
      ).rejects.toBeDefined()
      expect(JSON.parse(await readFile(ownerFile, 'utf8')).generation).toBe(owner.generation)
      const cli = createClient({
        transport: {
          kind: 'unix',
          path: owner.socketPath,
          ...(owner.socketPath.startsWith('\\\\.\\pipe\\')
            ? { serverIdentity: { pid: owner.pid, processStartId: owner.processStartId } }
            : {}),
        },
        auth: { kind: 'local' },
        journal: memoryJournal(),
      })
      clients.push(cli)
      const packageSource = join(cwd, 'audit-package')
      await cp(
        fileURLToPath(new URL('../../packages/package-manager/test/fixtures/pkg-a/', import.meta.url)),
        packageSource,
        { recursive: true },
      )
      const packageParams = {
        profile: 'local-dev',
        clientId: await cli.clientId(),
        source: { type: 'file' as const, ref: 'file:./audit-package' },
      }
      const waitPackage = async (operationId: string) => {
        const deadline = Date.now() + 30_000
        for (;;) {
          const operation = await cli.packages.operation.get({ profile: 'local-dev', operationId })
          if (['completed', 'failed', 'cancelled', 'rolled-back'].includes(operation.state)) {
            expect(operation).toMatchObject({ state: 'completed' })
            return operation
          }
          if (Date.now() >= deadline) throw new Error('package operation readiness timeout')
          await new Promise((done) => setTimeout(done, 50))
        }
      }
      const inspected = await cli.packages.inspect({ ...packageParams, commandId: 'acceptance-inspect' })
      const preview = await waitPackage(inspected.operationId)
      if (!preview.preview?.integrity) throw new Error('package inspection returned no integrity')
      const installParams = {
        ...packageParams,
        commandId: 'acceptance-install',
        expectedIntegrity: preview.preview.integrity,
      }
      const installed = await cli.packages.install(installParams)
      await waitPackage(installed.operationId)
      expect(await cli.packages.install(installParams)).toEqual(installed)
      const packageAuditFile = join(home, 'profiles', 'local-dev', '.agnes-package-audit.jsonl')
      const packageAudit = await readFile(packageAuditFile, 'utf8')
      const packageRows = packageAudit
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(packageRows).toHaveLength(1)
      expect(packageRows[0]).toMatchObject({ id: 'acme/pkg-a', result: 'committed', operation: 'install' })
      // guards-allow-platform: inspect the built daemon's actual package audit permissions.
      if (process.platform === 'win32') expect(hasPrivateDaclSync(packageAuditFile)).toBe(true)
      expect(await cli.config.get()).toMatchObject({ configured: false })
      await cli.config.save({
        providerId: 'deepseek',
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: 'deepseek-v4-flash',
        expectedRevision: 0,
      })
      const prompt = "共享后台中文请求，it's a test."
      const answer = await command(['-p', prompt])
      expect(answer.stdout).toContain('Shared backend acceptance reply.')
      expect(answer.stdout).toContain('中文验证通过。')
      expect(await readFile(editedFile, 'utf8')).toBe('after 中文')
      expect(provider.requests.length).toBeGreaterThan(0)
      expect(provider.requests.some((request) => JSON.stringify(request.messages).includes(prompt))).toBe(
        true,
      )
      const sessions = await cli.session.list({})
      const id = sessions.items[0]?.sessionId
      if (!id) throw new Error('print command failed to persist a session')
      const exportName = '会话 导出.agnes'
      const exportPath = join(cwd, exportName)
      await writeFile(exportPath, 'old export', 'utf8')
      const exported = await command(['export', id, '--raw', '-o', exportName])
      expect(exported.stderr).toContain('warning: --raw exports without redaction')
      const exportedRows = (await readFile(exportPath, 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(exportedRows.some((row) => row.type === 'assistant/message')).toBe(true)
      expect(JSON.stringify(exportedRows)).toContain('中文验证通过。')
      if (process.platform === 'win32') expect(hasPrivateDaclSync(exportPath)).toBe(true)
      web = spawn(node, [localEntry, 'serve', '--port', String(port)], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const webChild = web
      // The local launcher prints a plain loopback URL. No browser credential is handed off.
      const launchUrl = await new Promise<URL>((done, reject) => {
        let output = ''
        const timer = setTimeout(() => reject(new Error('Web launcher readiness timeout')), 30_000)
        webChild.once('error', () => {
          clearTimeout(timer)
          reject(new Error('Web launch failed'))
        })
        webChild.once('exit', () => {
          clearTimeout(timer)
          reject(new Error('Web exited before readiness'))
        })
        webChild.stdout?.on('data', (chunk) => {
          output += String(chunk)
          const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//)
          if (match) {
            clearTimeout(timer)
            done(new URL(match[0]))
          }
        })
      })
      expect(launchUrl.hash).toBe('')
      const response = await fetch(origin)
      expect(response.status).toBe(200)
      const html = await response.text()
      const ws = html.match(/data-ws="([^"]+)"/)?.[1]
      if (!ws) throw new Error('Web did not receive its backend URL')
      const browser = createClient({
        transport: {
          kind: 'ws',
          url: ws,
          protocols: ['agnes-v1'],
        },
        transportFactories: {
          ws: (option) => wsTransport({ ...option, url: ws, headers: { Origin: origin } }),
        },
        auth: { kind: 'local' },
        journal: memoryJournal(),
      })
      clients.push(browser)
      expect(await browser.config.get()).toEqual(await cli.config.get())
      const session = await browser.session.load(id, { cwd })
      expect(JSON.stringify(await session.projectUI(undefined, { surface: 'web' }))).toContain(
        'Shared backend acceptance reply.',
      )
      const currentOwner = JSON.parse(await readFile(ownerFile, 'utf8'))
      expect(currentOwner.generation).toBe(owner.generation)
      await browser.close()
      await exitChild(webChild)
      web = undefined
      // Closing the Web server cannot terminate a shared daemon or its other clients.
      expect(await cli.config.get()).toMatchObject({ configured: true })
      expect((await command(['daemon', 'status'])).stdout).toContain('true')
      // Same-build directory switching proves portable paths and persistent data reuse, not
      // different-version schema migration. Keep the old complete distribution for rollback.
      const nextRoot = join(root, '第二个版本 目录')
      await cp(portableRoot, nextRoot, { recursive: true })
      const candidateEntry = join(nextRoot, 'agnes.mjs')
      const preflightHome = join(root, 'preflight-home')
      const preflightEnv = { ...env, HOME: preflightHome, AGH_HOME: preflightHome }
      const daemonEntry = join(nextRoot, 'daemon.mjs')
      await rename(daemonEntry, `${daemonEntry}.unavailable`)
      try {
        await expect(
          command(['sessions', '--json'], cwd, preflightEnv, candidateEntry),
        ).rejects.toMatchObject({
          code: ExitCode.USAGE,
        })
      } finally {
        await rename(`${daemonEntry}.unavailable`, daemonEntry)
      }
      // A broken candidate must not replace or stop the live original instance.
      expect(JSON.parse(await readFile(ownerFile, 'utf8')).generation).toBe(owner.generation)
      expect(await cli.config.get()).toMatchObject({ configured: true })
      try {
        const preflight = await command(['sessions', '--json'], cwd, preflightEnv, candidateEntry)
        expect(JSON.parse(preflight.stdout).items).toEqual([])
      } finally {
        await command(['daemon', 'stop'], cwd, preflightEnv, candidateEntry)
      }
      expect(JSON.parse(await readFile(ownerFile, 'utf8')).generation).toBe(owner.generation)
      expect(await cli.config.get()).toMatchObject({ configured: true })
      await cli.close()
      await command(['daemon', 'stop'])
      localEntry = join(nextRoot, 'agnes.mjs')
      const afterRestart = await command(['sessions', '--json'])
      expect(
        JSON.parse(afterRestart.stdout).items.some((item: { sessionId: string }) => item.sessionId === id),
      ).toBe(true)
      const nextOwner = JSON.parse(await readFile(ownerFile, 'utf8'))
      expect(nextOwner.generation).not.toBe(owner.generation)
      expect(await readFile(packageAuditFile, 'utf8')).toBe(packageAudit)
      expect((await command(['-p', '--resume', id, 'Reply again after restart.'])).stdout).toContain(
        'Shared backend acceptance reply.',
      )
      provider.queueTool({ name: 'shell', args: { command: 'echo unexpected > shell-should-not-run.txt' } })
      // Rejection is a tool result; the model may then complete its answer with CLI exit 0.
      // Check the actual denial and missing side effect, not the final turn exit code.
      const denied = await command(['-p', 'Run the requested shell probe.'])
      expect(denied.stdout).toContain('Shared backend acceptance reply.')
      expect(provider.requests.at(-1)?.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: 'tool', content: 'approval rejected' })]),
      )
      await expect(readFile(join(cwd, 'shell-should-not-run.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      // Stop the selected distribution before switching back; never overwrite a loaded binary.
      await command(['daemon', 'stop'])
      localEntry = join(portableRoot, 'agnes.mjs')
      const afterSwitchBack = await command(['sessions', '--json'])
      expect(
        JSON.parse(afterSwitchBack.stdout).items.some((item: { sessionId: string }) => item.sessionId === id),
      ).toBe(true)
      expect((await command(['-p', '--resume', id, 'Reply after switching back.'])).stdout).toContain(
        'Shared backend acceptance reply.',
      )
      expect(await readFile(consentFile, 'utf8')).toBe('telemetry:\n  consent: LOCAL\n')
      const auditDirectory = join(home, 'data', 'audit')
      const auditFile = join(auditDirectory, 'host.jsonl')
      const auditLines = (await readFile(auditFile, 'utf8')).trimEnd().split('\n')
      expect(auditLines.some((line) => JSON.parse(line).kind === 'host.ready')).toBe(true)
      // guards-allow-platform: inspect the actual relocated Windows runtime's audit DACLs.
      if (process.platform === 'win32') {
        expect(hasPrivateDaclSync(auditDirectory)).toBe(true)
        expect(hasPrivateDaclSync(auditFile)).toBe(true)
      }
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()))
      if (web) await exitChild(web)
      await command(['daemon', 'stop']).catch(() => undefined)
      await provider.close()
      if (process.env.AGNES_ACCEPTANCE_TIMING_FILE)
        await writeFile(
          process.env.AGNES_ACCEPTANCE_TIMING_FILE,
          JSON.stringify({ shell: outerShell?.version ?? 'node', timings }, null, 2),
          'utf8',
        )
      if (process.env.AGNES_ACCEPTANCE_KEEP_OUTPUT === '1')
        console.info(`Acceptance output retained: ${root}`)
      else await rm(root, { recursive: true, force: true })
    }
  },
  180_000,
)
