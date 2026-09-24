// Fixture for DBH FAIL-002. Runs production pump() (packages/cli/src/modes/jsonl.ts) in a real
// Node process with Node's default --unhandled-rejections=throw, no vitest and no test-installed
// process handlers.
//
// Shape: stdin never reaches EOF, so pump stays parked on the stdin promise at jsonl.ts:132. One
// endpoint notification is forwarded while stdout is permanently backpressured, so send() rejects
// on the 1s drain timeout (jsonl.ts:49) and the bare `forward` promise (jsonl.ts:98-100) rejects
// with nothing attached to it -- Promise.allSettled at jsonl.ts:185 is never reached.
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { JsonRpcMessage } from '@agnes/sdk'
import { pump } from '../../src/modes/jsonl.js'
import type { CliRpcEndpoint } from '../../src/types.js'

class BlockedStdout extends EventEmitter {
  write(): boolean {
    return false
  }
  end(): void {}
}

const stdin = new PassThrough()
const endpoint: CliRpcEndpoint = {
  async handle() {
    return undefined
  },
  notifications: (async function* () {
    yield { jsonrpc: '2.0', method: 'session/update', params: {} } as unknown as JsonRpcMessage
    await new Promise<void>(() => {})
  })(),
  async close() {},
}

void pump({
  endpoint,
  stdin,
  stdout: new BlockedStdout() as unknown as NodeJS.WritableStream,
  stderr: process.stderr,
})

// Outlives the 1s drain timeout. If the session survives the failed notification write, this is the
// only thing that ends the process.
setTimeout(() => {
  process.stderr.write('dbh: session survived the failed notification write\n')
  process.exit(0)
}, 4_000)
