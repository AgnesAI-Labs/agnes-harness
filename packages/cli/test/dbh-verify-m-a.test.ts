// DBH M-A verification. Production entry under test: pump() in packages/cli/src/modes/jsonl.ts
// (reached from `agnes acp` via modes/acp.ts:12). Asserts the CORRECT behaviour, so a failure here
// reproduces the defect.
//
// Oracle, independent of the line under test: the sibling writer in the SAME function.
// jsonl.ts:110-126 `enqueue` extends the same `chain` and terminates it with `.catch(...)` (:123);
// jsonl.ts:128-130 `enqueueError` extends the same `chain` with no `.catch`. Once a protocol-error
// write rejects, `chain` stays rejected and the NEXT frame's `.then(f)` skips `f` entirely -- the
// request never reaches endpoint.handle and never gets a JSON-RPC response, violating JSON-RPC 2.0
// "every request with an id gets exactly one response".
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { JsonRpcMessage } from '@agnes/sdk'
import { describe, expect, it } from 'vitest'
import { pump } from '../src/modes/jsonl.js'
import type { CliRpcEndpoint } from '../src/types.js'

/** stdout that is permanently blocked: write() reports backpressure and 'drain' never fires. */
class BlockedStdout extends EventEmitter {
  readonly chunks: string[] = []
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk))
    return false
  }
  end(): void {}
}

const frame = (id: number, method: string): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method, params: {} })}\n`

async function run(firstLine: string): Promise<{ handled: string[]; stderr: string }> {
  const stdin = new PassThrough()
  const stdout = new BlockedStdout() as unknown as NodeJS.WritableStream
  const stderr = new PassThrough()
  let stderrText = ''
  stderr.on('data', (c) => {
    stderrText += String(c)
  })
  const handled: string[] = []
  const endpoint: CliRpcEndpoint = {
    async handle(message) {
      const m = message as { id?: number; method?: string }
      handled.push(m.method ?? `response:${String(m.id)}`)
      return m.id === undefined ? undefined : ({ jsonrpc: '2.0', id: m.id, result: {} } as JsonRpcMessage)
    },
    notifications: (async function* () {})(),
    async close() {},
  }
  const done = pump({ endpoint, stdin, stdout, stderr }).catch(() => undefined)
  stdin.write(firstLine)
  stdin.write(frame(1, 'initialize'))
  stdin.end()
  await done
  return { handled, stderr: stderrText }
}

describe('DBH M-A: a failed protocol-error write must not swallow the next request', () => {
  it('[control] a healthy first frame lets the following initialize reach the endpoint', async () => {
    const r = await run(frame(0, 'ping'))
    expect(r.handled).toEqual(['ping', 'initialize'])
  }, 20_000)

  it('a first line that is not JSON must not stop initialize from reaching the endpoint', async () => {
    const r = await run('{\n')
    expect(r.handled, `stderr=${JSON.stringify(r.stderr)}`).toEqual(['initialize'])
  }, 20_000)

  // Preservation: the sibling terminator reports the write failure on stderr instead of discarding
  // it (jsonl.ts:123-125). A fix that swallowed the rejection silently would still turn the case
  // above green, so the failure has to stay observable.
  it('[preserve] the failed protocol-error write is still reported on stderr', async () => {
    const r = await run('{\n')
    expect(r.stderr).toContain('ACP output drain timeout')
  }, 20_000)
})
