// Deep Bug Hunt M-03, supplementary dynamic source (adversarial-tester, group A). Test-only.
// A real child process: production main() -p with the real process.stdin pipe, a real OS SIGINT and
// the real hardExit; real test Host via fixtures/dbh-m06-slow-acp-cli.ts. Asserts the CORRECT
// behaviour, so a failure reproduces the defect.
// Oracle: boot/signals.ts:18; cli-package design :126; sibling modes/tui.ts:79-81.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const fixture = fileURLToPath(new URL('./fixtures/dbh-m06-slow-acp-cli.ts', import.meta.url))

async function runPrint(signalFirst: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'dbh-m03-sub-'))
  const dataDir = join(root, 'host')
  const home = join(root, 'home')
  mkdirSync(dataDir)
  mkdirSync(home)
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, '-p', 'x', '--cwd', dataDir], {
    env: {
      ...process.env,
      AGH_HOME: home,
      AGNES_ACP_FIXTURE_DIR: dataDir,
      DBH_TURN_MS: '1',
      DBH_ANNOUNCE_LADDER: '1',
      TMPDIR: root,
      TMP: root,
      TEMP: root,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (c) => {
    stdout += String(c)
  })
  child.stderr.on('data', (c) => {
    stderr += String(c)
  })
  child.stdin.on('error', () => undefined)
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const killer = setTimeout(() => child.kill('SIGKILL'), 40_000)
  try {
    for (const deadline = performance.now() + 30_000; !stderr.includes('dbh: SIGINT listener installed'); ) {
      if (performance.now() > deadline || child.exitCode !== null)
        throw new Error(`no ladder; stderr=${stderr}`)
      await new Promise((r) => setTimeout(r, 2))
    }
    if (signalFirst) child.kill('SIGINT')
    // Give the signal time to be delivered and handled before the prompt material arrives.
    await new Promise((r) => setTimeout(r, 200))
    child.stdin.end('piped')
    const exit = await exited
    return { ...exit, modelCalled: stderr.includes('dbh: turn started'), stdout, stderr }
  } finally {
    clearTimeout(killer)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await exited
    }
    rmSync(root, { recursive: true, force: true })
  }
}

describe('DBH M-03 subprocess: real SIGINT before piped stdin reaches EOF', () => {
  it('control: no signal, the prompt reaches the model and exits 0', async () => {
    const r = await runPrint(false)
    expect({ code: r.code, modelCalled: r.modelCalled }, r.stderr).toEqual({ code: 0, modelCalled: true })
  }, 60_000)

  it('SIGINT first: no prompt reaches the model, exit 130', async () => {
    const r = await runPrint(true)
    expect(
      { code: r.code, signal: r.signal, modelCalled: r.modelCalled },
      `stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr.slice(-300))}`,
    ).toEqual({ code: 130, signal: null, modelCalled: false })
  }, 60_000)
})
