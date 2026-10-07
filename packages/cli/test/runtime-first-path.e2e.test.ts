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
// A real projection provider is installed over a synthetic domain, without a C14 HTTP issuer.
// Downstream Supervisor, acceptInbox, modelContext and Loop cold State still have no production
// consumer on this entry. Never replace them with successful synthetic receipts.
// Resolved: Loop credential restrictions no longer block the real Host model egress.
// runtime-admission.e2e.test.ts proves C22-issued handles and HTTP in a real worker. Its
// State/Routing/Supervisor/identity peers remain restricted substitutes. Its credential-c04 row
// now uses real C04 prepare/registry and stops at composite dispatch, with no model success receipt.
// This CLI skeleton still has no client command-to-admission bridge.
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
      try {
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
      } catch (error) {
        // A hosted runner that never reaches the seam otherwise leaves nothing to diagnose from.
        let seen = '(no log)'
        try {
          seen = readFileSync(log, 'utf8').slice(-2000)
        } catch {}
        throw new Error(
          `daemon never reached the ready seam (alive: ${daemon.child.exitCode === null})\nlog: ${seen}\nstdout: ${daemon.stdout().slice(-2000)}\nstderr: ${daemon.stderr().slice(-2000)}`,
          { cause: error },
        )
      }
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
          error: { code: 'denied', detailCode: 'projection_context_issuer_unavailable' },
        })
        expect(observation.selectedCommand).toMatchObject({
          state: 'failed',
          error: { detailCode: 'operation_not_supported' },
        })
      }
      expect(observation.projection.body).toMatchObject({
        ok: false,
        error: { code: 'denied', detailCode: 'projection_context_issuer_unavailable' },
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
