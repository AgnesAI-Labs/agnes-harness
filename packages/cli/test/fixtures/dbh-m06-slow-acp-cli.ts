// Deep Bug Hunt M-06 test-only fixture (adversarial-tester, group A). The existing acp-cli.ts fixture
// (not modified) no longer boots at HEAD: its hand-rolled Host lacks callService, which
// createLocalEndpoint now binds. This one uses the same real test Host the in-process suites use
// (createTestHost + slowProvider from boot-host.ts). DBH_TURN_MS sets how long a model call takes;
// the provider announces its start on stderr so the test has a barrier. Production main() runs
// unmodified with the real process signals, the real hardExit and the real --ephemeral home.
import { createTestHost } from '@agnes/host/testkit'
import { main } from '../../src/bin.js'
import { slowProvider, TEST_LOCK } from '../boot-host.js'

const dataDir = process.env.AGNES_ACP_FIXTURE_DIR
if (!dataDir) throw new Error('AGNES_ACP_FIXTURE_DIR is required')
const turnMs = Number(process.env.DBH_TURN_MS ?? 60_000)

// Optional barrier for M-03: announce when production code installs a SIGINT listener (the ladder,
// bin.ts:573 -> signals.ts:72). Observation only; the listener itself is passed through untouched.
if (process.env.DBH_ANNOUNCE_LADDER) {
  const on = process.on.bind(process)
  process.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
    const result = on(event, listener)
    if (event === 'SIGINT') process.stderr.write('dbh: SIGINT listener installed\n')
    return result
  }) as typeof process.on
}

void main(
  process.argv.slice(2),
  {
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: dataDir,
    agnesVersion: '0.0.0-test',
  },
  {
    lock: TEST_LOCK,
    createHostImpl: async () => {
      const { host } = await createTestHost({
        dataDir,
        provider: slowProvider(turnMs, () => process.stderr.write('dbh: turn started\n')),
      })
      // DBH_HANG_CLOSE: a host whose close never settles -- the seam that will not close, which is what
      // the signal ladder's grace timer and second-signal rung exist for.
      if (process.env.DBH_HANG_CLOSE) host.close = () => new Promise<void>(() => undefined)
      return host
    },
  },
).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`)
    process.exitCode = 1
  },
)
