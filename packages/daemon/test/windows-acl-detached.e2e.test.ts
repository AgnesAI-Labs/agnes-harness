// Windows write-restricted execution through a daemon the normal CLI starts detached, as a user starts
// it: `agh daemon start` from the built local distribution, then SDK clients over its named pipe.
// Commands run as the session's own jobs and as the model's shell tool (the keyless demo model calls
// the tool a prompt names), under Windows PowerShell 5.1 and PowerShell 7, and as Node. Home, data,
// LocalAppData, workspace and every input are synthetic; no credential is read.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeHome } from '@agnes/host'
import { demoProvider } from '@agnes/package-manager'
import { type Client, createClient, memoryJournal, type Session } from '@agnes/sdk'
import { windowsProcessStartTimeSync } from '@agnes/system-node'
import { windowsDetachedCommand } from '@agnes/system-node/process-detached'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readDaemonDiscovery, resolveDaemonScope } from '../src/index.js'

// This file consumes the real local distribution. Build it first: @agnes/cli build:local.
const cli = fileURLToPath(new URL('../../cli/dist/local/agnes.mjs', import.meta.url))
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
const icacls = join(systemRoot, 'System32', 'icacls.exe')
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Node programs the commands run, kept as files so no shell rewrites their source. */
const PROGRAMS = {
  // Records its literal arguments, stdin up to EOF, TEMP and cwd, prints Unicode and exits 7.
  'argv.cjs': `const fs = require('node:fs');
const [out, ...args] = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8').on('data', (chunk) => { input += chunk });
process.stdin.on('end', () => {
  fs.writeFileSync(out, JSON.stringify({ args, input, temp: process.env.TEMP, cwd: process.cwd() }));
  process.stdout.write('stdout 中文 ' + args.join('|'));
  process.exitCode = 7;
});`,
  // Leaves a detached descendant that would write a file later, then exits at once.
  'leave.cjs': `const fs = require('node:fs');
const [pidFile, late] = process.argv.slice(2);
const child = require('node:child_process').spawn(process.execPath,
  ['-e', 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "late"), 5000)', late],
  { detached: true, stdio: 'ignore', windowsHide: true });
child.once('spawn', () => { fs.writeFileSync(pidFile, String(child.pid)); process.exit(0) });`,
  // Runs until stopped: a descendant, a heartbeat in the workspace and a file in its TEMP.
  'resident.cjs': `const fs = require('node:fs'), path = require('node:path');
const [info, beat] = process.argv.slice(2);
fs.writeFileSync(path.join(process.env.TEMP, 'alive.txt'), 'alive');
const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
  { detached: true, stdio: 'ignore', windowsHide: true });
child.once('spawn', () => fs.writeFileSync(info, JSON.stringify({ pid: process.pid, child: child.pid, temp: process.env.TEMP })));
setInterval(() => fs.appendFileSync(beat, '.'), 200);`,
} as const

/** A PowerShell single-quoted literal. */
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`

type Daemon = Readonly<{
  root: string
  workspace: string
  outside: string
  tools: string
  tempRoot: string
  connect(): Promise<Client>
  stop(): void
}>

/** An isolated home, LocalAppData and workspace, and a daemon started by `agh daemon start`. */
async function startDaemon(version: '5.1' | '7'): Promise<Daemon> {
  expect(existsSync(cli), 'build @agnes/cli build:local before this file').toBe(true)
  if (version === '7') {
    const where = spawnSync('where.exe', ['pwsh.exe'], { encoding: 'utf8' })
    if (where.status !== 0)
      throw new Error('PowerShell 7 (pwsh.exe) must be on PATH for this acceptance file')
  }
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agh-acl-daemon-')))
  const dir = (name: string) => {
    mkdirSync(join(root, name))
    return join(root, name)
  }
  const home = join(root, 'home')
  const workspace = dir('work')
  const outside = dir('outside')
  const tools = dir('tools')
  const localAppData = dir('local-app-data')
  for (const [name, source] of Object.entries(PROGRAMS)) writeFileSync(join(tools, name), source)
  initializeHome(home, 'local-dev')
  const profileDir = join(home, 'profiles', 'local-dev')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    join(profileDir, 'profile.yaml'),
    JSON.stringify({ name: 'local-dev', provider: demoProvider() }),
  )
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('AGNES_') && !key.startsWith('VITEST_') && key !== 'NODE_OPTIONS',
    ),
  )
  Object.assign(env, {
    AGH_HOME: home,
    AGNES_PROFILE: 'local-dev',
    LOCALAPPDATA: localAppData,
    AGNES_POWERSHELL: version,
  })
  const control = (command: string) =>
    spawnSync(process.execPath, [cli, 'daemon', command], {
      cwd: workspace,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    })
  const started = control('start')
  expect(started.status, `${started.stdout}${started.stderr}`).toBe(0)
  return {
    root,
    workspace,
    outside,
    tools,
    tempRoot: join(localAppData, 'AgnesHarness', 'acl-temp', 'v1'),
    connect: async () => {
      const scope = await resolveDaemonScope({ home, workspace, env })
      const discovery = await readDaemonDiscovery(scope)
      if (!discovery) throw new Error('daemon discovery is missing')
      const client = createClient({
        journal: memoryJournal(),
        auth: { kind: 'local' },
        transport: {
          kind: 'unix',
          path: discovery.socketPath,
          serverIdentity: { pid: discovery.owner.pid, processStartId: discovery.owner.processStartId },
        },
      })
      await client.initialize()
      return client
    },
    stop: () => {
      control('stop')
      try {
        execFileSync(icacls, [root, '/reset', '/T', '/C', '/Q'], { stdio: 'ignore' })
      } catch {}
      rmSync(root, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

/** All processes, for walking from a business process up to the Host that launched it. */
function processTable(): Map<number, { parent: number; commandLine: string }> {
  const rows = JSON.parse(
    execFileSync(
      join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    ),
  ) as Array<{ ProcessId: number; ParentProcessId: number; CommandLine: string | null }>
  return new Map(
    rows.map((row) => [row.ProcessId, { parent: row.ParentProcessId, commandLine: row.CommandLine ?? '' }]),
  )
}

async function gone(pid: number, timeout = 15_000) {
  await expect.poll(() => windowsProcessStartTimeSync(pid), { timeout }).toBeNull()
}

async function readJson<T>(path: string, timeout = 30_000): Promise<T> {
  await expect.poll(() => existsSync(path) && readFileSync(path, 'utf8').length > 0, { timeout }).toBe(true)
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

type Resident = { pid: number; child: number; temp: string }

/** Names the request a JSON-RPC refusal answered and keeps its data, which says why. */
async function answered<T>(request: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    const { message, data } = error as { message?: string; data?: unknown }
    throw new Error(`${request}: ${message ?? String(error)} ${JSON.stringify(data ?? null)}`, {
      cause: error,
    })
  }
}

for (const version of ['5.1', '7'] as const)
  describe.skipIf(process.platform !== 'win32')(
    `Windows write restriction in a detached daemon with PowerShell ${version}`,
    { timeout: 180_000 },
    () => {
      let daemon: Daemon
      let client: Client
      const node = (program: keyof typeof PROGRAMS, ...args: string[]) =>
        `& ${literal(process.execPath)} ${[join(daemon.tools, program), ...args].map(literal).join(' ')}; exit $LASTEXITCODE`

      beforeAll(async () => {
        daemon = await startDaemon(version)
        client = await daemon.connect()
        await client.workspace.add(daemon.workspace)
      }, 300_000)
      afterAll(async () => {
        await client?.close().catch(() => undefined)
        daemon?.stop()
      }, 120_000)

      let opened = 0
      // One workspace names one session unless the caller names another, and an open session of one
      // level refuses to be opened at a different level, so every session here has its own key.
      async function newSession(permission: 'workspace-write' | 'read-only' = 'workspace-write') {
        const session = await answered(`session.new ${permission}`, () =>
          client.session.new({
            cwd: daemon.workspace,
            permission,
            sessionKey: `acl-${version}-${++opened}-${permission}`,
          }),
        )
        session.onPermissionRequest(async () => ({ verdict: 'allowed-once' }))
        return session
      }
      async function settled(session: Session, id: string, timeout = 90_000) {
        const deadline = Date.now() + timeout
        for (;;) {
          const { job } = await session.jobsRead(id)
          if (job && job.status !== 'running') return job
          if (Date.now() > deadline) throw new Error(`job still running: ${JSON.stringify(job)}`)
          await delay(200)
        }
      }
      async function job(session: Session, command: string, timeoutMs = 60_000) {
        const started = await answered('session.jobs.control run', () =>
          session.jobsRun(command, { timeoutMs }),
        )
        return { id: started.id, done: () => settled(session, started.id) }
      }
      const timeline = async (session: Session) => JSON.stringify(await session.projectUI())
      const shellCall = (args: Record<string, unknown>) => `call shell ${JSON.stringify(args)}`

      it('runs the selected PowerShell and Node with literal arguments, Unicode, stdin to EOF and exit code 7', async () => {
        const session = await newSession()
        const shell = await (
          await job(session, "[Console]::Out.Write('ps=' + $PSVersionTable.PSVersion.Major + ' 中文')")
        ).done()
        expect(shell, JSON.stringify(shell)).toMatchObject({ status: 'completed', code: 0 })
        expect(shell.stdout).toContain(`ps=${version === '5.1' ? 5 : 7} 中文`)
        const facts = join(daemon.workspace, `argv-${version}.json`)
        const args = ['中文 空格', 'two  spaces', '$literal', '-not-an-option']
        const result = await (await job(session, `'输入 中文' | ${node('argv.cjs', facts, ...args)}`)).done()
        expect(result, JSON.stringify(result)).toMatchObject({ status: 'failed', code: 7 })
        expect(result.stdout).toContain(`stdout 中文 ${args.join('|')}`)
        const recorded = await readJson<{ args: string[]; input: string; temp: string; cwd: string }>(facts)
        expect(recorded.args).toEqual(args)
        expect(recorded.input.replace(/\r?\n$/, '')).toBe('输入 中文')
        expect(recorded.temp.startsWith(join(daemon.tempRoot, 'lease-'))).toBe(true)
        expect(realpathSync.native(recorded.cwd)).toBe(daemon.workspace)
      })

      it('writes the workspace and its private temp and nothing outside; read-only writes nowhere', async () => {
        const write = await newSession()
        const outsideFile = join(daemon.outside, `outside-${version}.txt`)
        const steps = (pairs: Array<[string, string]>) =>
          [
            "$ErrorActionPreference = 'Stop'",
            '$results = @()',
            ...pairs.map(
              ([name, body]) =>
                `try { ${body} | Out-Null; $results += ${literal(`${name}=ok`)} } catch { $results += ${literal(`${name}=denied`)} }`,
            ),
            // A read-only PowerShell has no writable temp and runs in Constrained Language Mode, which
            // refuses method calls such as [Console]::Out.Write.
            "Write-Host -NoNewline ($results -join ';')",
          ].join('\n')
        const written = await (
          await job(
            write,
            steps([
              ['create', `Set-Content -LiteralPath 'made.txt' -Value 'x'`],
              ['directory', `New-Item -ItemType Directory -Path 'made-dir'`],
              ['rename', `Rename-Item -LiteralPath 'made.txt' -NewName 'renamed.txt'`],
              ['remove', `Remove-Item -LiteralPath 'renamed.txt'; Remove-Item -LiteralPath 'made-dir'`],
              ['temp', `Set-Content -LiteralPath (Join-Path $env:TEMP 'scratch.txt') -Value 'x'`],
              ['outside', `Set-Content -LiteralPath ${literal(outsideFile)} -Value 'x'`],
            ]),
          )
        ).done()
        expect(written, JSON.stringify(written)).toMatchObject({ status: 'completed', code: 0 })
        expect(written.stdout).toContain('create=ok;directory=ok;rename=ok;remove=ok;temp=ok;outside=denied')
        expect(existsSync(outsideFile)).toBe(false)

        // A read-only session runs no background job (that capability is denied); its commands come
        // through the shell tool, and their output is on the timeline.
        const readOnly = await newSession('read-only')
        const refused = await readOnly.prompt(
          shellCall({
            command: `${steps([
              ['create', `Set-Content -LiteralPath 'read-only.txt' -Value 'x'`],
              ['outside', `Set-Content -LiteralPath ${literal(outsideFile)} -Value 'x'`],
            ])}\nWrite-Host -NoNewline (';temp=' + $env:TEMP)`,
          }),
        )
        expect(refused.reason).toBe('completed')
        const shown = await timeline(readOnly)
        expect(shown).toContain('create=denied;outside=denied')
        expect(shown).not.toContain(daemon.tempRoot.replaceAll('\\', '\\\\'))
        expect(existsSync(join(daemon.workspace, 'read-only.txt'))).toBe(false)
      })

      it('keeps a persistent shell and hands a background command over to the session', async () => {
        const session = await newSession()
        const first = await session.prompt(
          shellCall({ command: "$kept = 'kept-' + 'value'; [Console]::Out.Write('set')", persistent: true }),
        )
        expect(first.reason).toBe('completed')
        const second = await session.prompt(
          shellCall({ command: "[Console]::Out.Write('persistent=' + $kept)", persistent: true }),
        )
        expect(second.reason).toBe('completed')
        expect(await timeline(session)).toContain('persistent=kept-value')

        const marker = join(daemon.workspace, `background-${version}.txt`)
        const background = await session.prompt(
          shellCall({
            command: `Start-Sleep -Seconds 3; Set-Content -LiteralPath ${literal(marker)} -Value 'done'`,
            background: true,
          }),
        )
        expect(background.reason).toBe('completed')
        // The turn ended before the command did; the session keeps running it.
        expect(existsSync(marker)).toBe(false)
        await expect.poll(() => existsSync(marker), { timeout: 30_000 }).toBe(true)
      })

      it('stops descendants a command leaves behind when its main process exits', async () => {
        const session = await newSession()
        const pidFile = join(daemon.workspace, `left-${version}.pid`)
        const late = join(daemon.workspace, `late-${version}.txt`)
        const result = await (await job(session, node('leave.cjs', pidFile, late))).done()
        expect(result, JSON.stringify(result)).toMatchObject({ status: 'completed', code: 0 })
        const pid = Number(readFileSync(pidFile, 'utf8'))
        await gone(pid)
        await delay(6_000)
        expect(existsSync(late)).toBe(false)
      })

      it('stops a cancelled and a timed-out command together with its descendants', async () => {
        const session = await newSession()
        const cancelInfo = join(daemon.workspace, `cancel-${version}.json`)
        const cancelled = await job(
          session,
          node('resident.cjs', cancelInfo, join(daemon.workspace, 'beat-cancel')),
        )
        const running = await readJson<Resident>(cancelInfo)
        await session.jobsControl({ operation: 'kill', jobId: cancelled.id })
        expect(await cancelled.done()).toMatchObject({ status: 'killed' })
        await gone(running.pid)
        await gone(running.child)

        const timeoutInfo = join(daemon.workspace, `timeout-${version}.json`)
        const timed = await job(
          session,
          node('resident.cjs', timeoutInfo, join(daemon.workspace, 'beat-timeout')),
          2_000,
        )
        const timing = await readJson<Resident>(timeoutInfo)
        expect(await timed.done()).toMatchObject({ status: 'killed' })
        await gone(timing.pid)
        await gone(timing.child)
      })

      it('does not dispose a live runtime when its client disconnects', async () => {
        const session = await newSession()
        const info = join(daemon.workspace, `disconnect-${version}.json`)
        const beat = join(daemon.workspace, `beat-disconnect-${version}`)
        const resident = await job(session, node('resident.cjs', info, beat))
        const { temp } = await readJson<Resident>(info)
        expect(existsSync(join(temp, 'alive.txt'))).toBe(true)
        await client.close()
        await delay(2_000)
        client = await daemon.connect()
        const reopened = await client.session.load(session.id, { cwd: daemon.workspace, history: 'none' })
        const { job: still } = await reopened.jobsRead(resident.id)
        expect(still?.status).toBe('running')
        expect(existsSync(temp)).toBe(true)
        const before = statSync(beat).size
        await expect.poll(() => statSync(beat).size, { timeout: 10_000 }).toBeGreaterThan(before)
        await reopened.jobsControl({ operation: 'kill', jobId: resident.id })
        expect(await settled(reopened, resident.id)).toMatchObject({ status: 'killed' })
      })

      // Last in this daemon: it kills the session worker that hosts the runtime.
      it('stops business processes when the Host crashes and releases its temp at the next grant', async () => {
        const session = await newSession()
        const info = join(daemon.workspace, `crash-${version}.json`)
        await job(session, node('resident.cjs', info, join(daemon.workspace, 'beat-crash')))
        const running = await readJson<Resident>(info)
        const table = processTable()
        let host: number | undefined
        for (
          let pid = table.get(running.pid)?.parent;
          pid !== undefined && pid > 0;
          pid = table.get(pid)?.parent
        ) {
          if (/worker\.mjs/.test(table.get(pid)?.commandLine ?? '')) {
            host = pid
            break
          }
        }
        if (host === undefined) throw new Error('the Host worker of the business process was not found')
        execFileSync(join(systemRoot, 'System32', 'taskkill.exe'), ['/F', '/PID', String(host)], {
          stdio: 'pipe',
        })
        // The Host held the only handle to the Job, which kills its processes when it closes.
        await gone(running.pid)
        await gone(running.child)
        // Nothing released the dead Host's lease yet; the next grant transaction proves it gone first.
        expect(existsSync(running.temp)).toBe(true)
        const next = await newSession()
        expect(await (await job(next, "[Console]::Out.Write('next')")).done()).toMatchObject({
          status: 'completed',
        })
        expect(existsSync(running.temp)).toBe(false)
      })
    },
  )

// A daemon is started without a console, as `agh daemon start` does, and its broker gets a hidden one.
// The failure-injection build of the native module is refused by the product's loader and broker, so
// this case drives the restricted launch directly in that same process arrangement: a detached process
// starts a hidden-console child that creates the suspended target, proves Job membership and resumes.
describe.skipIf(process.platform !== 'win32')(
  'restricted launch from a process without a console, with injected failures',
  { timeout: 600_000 },
  () => {
    const output = join(tmpdir(), `agh-native-test-${process.pid}-${randomInt(1, 2 ** 30)}`)
    const artifact = join(output, 'agnes-system.node')
    let open = ''
    beforeAll(() => {
      execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL('../../system-node/scripts/build-native.mjs', import.meta.url)),
          '--output-dir',
          output,
          '--test-faults',
        ],
        { stdio: 'pipe', timeout: 600_000 },
      )
      open = realpathSync.native(mkdtempSync(join(tmpdir(), 'agh-acl-open-')))
      execFileSync(icacls, [open, '/grant', '*S-1-1-0:(OI)(CI)F'], { stdio: 'pipe' })
      execFileSync(icacls, [open, '/setintegritylevel', '(OI)(CI)L'], { stdio: 'pipe' })
    }, 600_000)
    afterAll(() => {
      rmSync(output, { recursive: true, force: true, maxRetries: 5 })
      if (open) rmSync(open, { recursive: true, force: true, maxRetries: 5 })
    })

    // Runs in the hidden-console child: creates the marker writer suspended and read-only, then either
    // checks its Job membership (the "job" fault) or resumes it and waits for its exit.
    const launcher = `const native = require(process.env.AGNES_TEST_ARTIFACT);
const pause = new Int32Array(new SharedArrayBuffer(4));
const result = { testBuild: native.testFaults === true };
let target;
try {
  target = native.spawnRestricted(process.execPath, process.env.AGNES_TEST_COMMAND_LINE, process.cwd(),
    'SystemRoot=' + process.env.SystemRoot + '\\0\\0', [], true, 'S-1-4-9');
  result.created = true;
  if (process.env.AGNES_TEST_FAULT === 'job') {
    const job = native.createProcessJob();
    try { result.member = job.contains(target.pid, target.startTime) } finally { job.close() }
  } else {
    target.resume();
    result.resumed = true;
    while (target.exitCode() === null) Atomics.wait(pause, 0, 0, 20);
    result.exitCode = target.exitCode();
  }
} catch (error) { result.error = error.code }
finally { target?.close() }
process.stdout.write(JSON.stringify(result));`
    // Runs detached, without a console: starts the launcher with a hidden console and records its answer.
    const detached = `const { spawnSync } = require('node:child_process');
const run = spawnSync(process.execPath, ['-e', process.env.AGNES_TEST_LAUNCHER], { windowsHide: true, encoding: 'utf8' });
require('node:fs').writeFileSync(process.env.AGNES_TEST_RESULT, JSON.stringify({ status: run.status, stdout: run.stdout, stderr: run.stderr }));`

    async function launch(fault: string) {
      const marker = join(open, `business-${fault}`)
      const result = join(open, `result-${fault}.json`)
      const child = spawn(process.execPath, ['-e', detached], {
        cwd: tmpdir(),
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env: {
          SystemRoot: systemRoot,
          AGNES_TEST_ARTIFACT: artifact,
          AGNES_TEST_FAULT: fault,
          AGNES_TEST_LAUNCHER: launcher,
          AGNES_TEST_RESULT: result,
          AGNES_TEST_COMMAND_LINE: windowsDetachedCommand(process.execPath, [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
          ]),
        },
      })
      const [code] = await once(child, 'exit')
      expect(code).toBe(0)
      const run = JSON.parse(readFileSync(result, 'utf8')) as {
        status: number
        stdout: string
        stderr: string
      }
      expect(run.status, run.stderr).toBe(0)
      await delay(500)
      return { result: JSON.parse(run.stdout), ran: existsSync(marker) }
    }

    it('runs business code when no step fails', async () => {
      const { result, ran } = await launch('none')
      expect(result).toEqual({ testBuild: true, created: true, resumed: true, exitCode: 0 })
      expect(ran).toBe(true)
    })

    it.each(['token', 'dacl', 'label', 'stdio', 'create', 'resume'])(
      'never runs business code when the %s step fails',
      async (step) => {
        const { result, ran } = await launch(step)
        expect(result.error).toBe('EIO')
        expect(result.resumed).toBeUndefined()
        expect(result.created).toBe(step === 'resume' ? true : undefined)
        expect(ran).toBe(false)
      },
    )

    it('never runs business code when its Job membership cannot be proven', async () => {
      const { result, ran } = await launch('job')
      expect(result).toEqual({ testBuild: true, created: true, error: 'EIO' })
      expect(ran).toBe(false)
    })
  },
)
