import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

function launch(name: string, env: NodeJS.ProcessEnv) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL(`./fixtures/runtime-first-path-${name}.ts`, import.meta.url))],
    {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = '',
    stderr = ''
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  return { child, exited, stdout: () => stdout, stderr: () => stderr }
}
async function stop(child: ChildProcess, exited: Promise<number | null>) {
  if (child.exitCode !== null || child.signalCode !== null) return exited
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  try {
    return await exited
  } finally {
    clearTimeout(timer)
  }
}

// An entry skeleton, not full-path acceptance: the first real refusal remains visible.
// Downstream C04, Supervisor, acceptInbox, modelContext sources and Loop cold State have no
// production consumer on this entry. Never replace them with successful synthetic receipts.
// Resolved: Loop credential restrictions no longer block the real Host model egress.
// runtime-admission.e2e.test.ts proves C22-issued handles and HTTP in a real worker. Its
// State/Routing/C04/Supervisor/identity peers remain restricted substitutes; this skeleton
// still has no admission owner, C04 request source or production model success receipt.
it.each(['absent', 'fixture'] as const)(
  'reaches runtime HTTP through real CLI/daemon/worker processes with %s bootstrap and keeps missing owners named',
  async (bootstrap) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-first-path-')))
    const log = join(root, 'processes.jsonl')
    const env = {
      ...process.env,
      AGH_HOME: root,
      AGNES_PROFILE: 'local-dev',
      FIRST_PATH_LOG: log,
      FIRST_PATH_BOOTSTRAP: bootstrap,
    }
    const daemon = launch('daemon', env)
    let cli: ReturnType<typeof launch> | undefined
    try {
      // Startup is observed at the fixture installer's ready seam, after the real worker gate/Host.
      await expect
        .poll(
          () => {
            if (daemon.child.exitCode !== null) throw Error(daemon.stderr())
            try {
              return readFileSync(log, 'utf8').includes('"method":"ready"')
            } catch {
              return false
            }
          },
          { timeout: 30_000, interval: 100 },
        )
        .toBe(true)
      cli = launch('cli', env)
      const timer = setTimeout(() => cli?.child.kill('SIGKILL'), 30_000)
      try {
        expect(await cli.exited, cli.stderr()).toBe(0)
      } finally {
        clearTimeout(timer)
      }
      const observation = JSON.parse(cli.stdout())
      expect(observation.pid).not.toBe(process.pid)
      expect(observation.daemonPid).toBe(daemon.child.pid)
      if (bootstrap === 'absent') {
        expect(observation.runtime).toMatchObject({ ok: false, code: 'runtime_unavailable' })
        expect(observation.bootstrapReplies).toEqual([
          expect.objectContaining({
            ok: false,
            error: expect.objectContaining({ detailCode: 'operation_not_supported' }),
          }),
        ])
      } else {
        expect(observation.runtime).toEqual({ ok: true })
        expect(observation.selectedRead).toMatchObject({
          state: 'failed',
          error: { code: 'incompatible', detailCode: 'projection_provider_installation_unavailable' },
        })
        expect(observation.selectedCommand).toMatchObject({
          state: 'failed',
          error: { detailCode: 'operation_not_supported' },
        })
      }
      expect(observation.projection.body).toMatchObject({
        ok: false,
        error: { code: 'incompatible', detailCode: 'projection_provider_installation_unavailable' },
      })
      expect(observation.command.body).toMatchObject({
        ok: false,
        error: { detailCode: 'operation_not_supported' },
      })
      expect(observation.unauthorized).toEqual({ status: 401, body: null })
      expect(await stop(daemon.child, daemon.exited), daemon.stderr()).toBe(0)
      const events = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const worker = events.find((event) => event.method === 'ready')
      expect(worker.pid).not.toBe(process.pid)
      expect(worker.pid).not.toBe(observation.pid)
      expect(worker.pid).not.toBe(daemon.child.pid)
      expect(events.filter((event) => event.method === 'state.createRun')).toEqual([])
      expect(events.filter((event) => event.method === 'close')).toEqual([
        { pid: worker.pid, method: 'close' },
      ])
      // Nothing was accepted; no synthetic State/model/tool/Usage/ledger success is claimed.
      expect(events.find((event) => event.role === 'domain-store')).toEqual({
        role: 'domain-store',
        state: { value: null, revision: 0 },
        sequence: 0,
        journal: [],
      })
    } finally {
      if (cli) await stop(cli.child, cli.exited)
      await stop(daemon.child, daemon.exited)
      rmSync(root, { recursive: true, force: true })
    }
  },
  75_000,
)
