// DBH FAIL-002 verification, real subprocess (same form as dbh-m03-print-subprocess.e2e.test.ts).
// Production entry: pump() in packages/cli/src/modes/jsonl.ts, reached by `agnes acp`.
// Asserts the CORRECT behaviour, so a failure here reproduces the defect.
//
// Oracle, independent of jsonl.ts: packages/worker-runtime/src/tail.ts:33-37 states the repo's own
// rule verbatim -- "under Node's default `--unhandled-rejections=throw` that ends the whole process
// and every other session with it" -- which is why every other long-lived promise in this codebase
// carries a terminal handler. `forward` (jsonl.ts:98-100) is the one that does not; nothing is
// attached to it until Promise.allSettled at jsonl.ts:185, which is only reached after stdin EOF.
// A failed notification write must not take the ACP process down: the endpoint is still live and
// the client is still owed answers to its in-flight requests.
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { JsonRpcMessage } from '@agnes/sdk'
import { describe, expect, it } from 'vitest'
import { pump } from '../src/modes/jsonl.js'
import type { CliRpcEndpoint } from '../src/types.js'

const fixture = fileURLToPath(new URL('./fixtures/dbh-verify-fail-002-forward.ts', import.meta.url))

async function run(): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (c) => {
    stderr += String(c)
  })
  child.stdout.resume()
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const killer = setTimeout(() => child.kill('SIGKILL'), 30_000)
  try {
    return { ...(await exited), stderr }
  } finally {
    clearTimeout(killer)
  }
}

describe('DBH FAIL-002: a failed notification write must not kill the ACP process', () => {
  it('exits 0 and keeps the session alive after the notification write times out', async () => {
    const r = await run()
    expect({ code: r.code, signal: r.signal }, `stderr=${JSON.stringify(r.stderr.slice(-800))}`).toEqual({
      code: 0,
      signal: null,
    })
    expect(r.stderr).toContain('dbh: session survived the failed notification write')
  }, 60_000)

  // Preservation: claiming forward's rejection must not swallow it. Once stdin reaches EOF the
  // Promise.allSettled at jsonl.ts:185 is reached, and jsonl.ts:187 still owes the caller the
  // failure. A fix that replaced `forward` with a caught promise would make this silently pass.
  it('[preserve] still reports a failed notification write once stdin reaches EOF', async () => {
    class BlockedStdout extends EventEmitter {
      write(): boolean {
        return false
      }
      end(): void {}
    }
    const stdin = new PassThrough()
    const stderr = new PassThrough()
    stderr.resume()
    const endpoint: CliRpcEndpoint = {
      async handle() {
        return undefined
      },
      notifications: (async function* () {
        yield { jsonrpc: '2.0', method: 'session/update', params: {} } as unknown as JsonRpcMessage
      })(),
      async close() {},
    }
    const run = pump({
      endpoint,
      stdin,
      stdout: new BlockedStdout() as unknown as NodeJS.WritableStream,
      stderr,
    })
    stdin.end()
    await expect(run).rejects.toThrow('ACP output drain timeout')
  }, 20_000)
})
