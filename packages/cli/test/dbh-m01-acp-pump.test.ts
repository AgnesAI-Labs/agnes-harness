// Deep Bug Hunt M-01 (adversarial-tester, group A). Test-only; asserts the CORRECT behaviour, so a
// failure here reproduces the defect. Production entry under test: pump() in src/modes/jsonl.ts.
//
// Independent protocol expectations:
//   signal => session/cancel first; a second prompt on a busy session => -32002 (so frames
//   must reach the endpoint while a prompt is in flight); the client is the prompter
//   (session/request_permission responses must reach the endpoint mid-turn); :149 close => stop
//   receiving -> cancel the in-flight turn. daemon/src/local/methods/acp.ts:327 keeps handle() open
//   for the whole turn, and :347-350 is the only way a turn is cancelled over ACP.
import { PassThrough } from 'node:stream'
import type { JsonRpcMessage } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { pump } from '../src/modes/jsonl.js'
import type { CliRpcEndpoint } from '../src/types.js'

const FALLBACK_MS = 1_500

type Wire = { id?: string | number; method?: string; result?: unknown; error?: unknown }

/**
 * Minimal endpoint honouring the daemon LocalEndpoint contract: handle() for a prompt stays pending
 * until the turn ends; a turn ends when session/cancel is handled, when close() is called, when the
 * awaited s2c response is handled, or when a fallback timer fires. `openedBy` records which.
 */
function stubEndpoint(o: { awaitS2c?: string } = {}) {
  const handled: string[] = []
  let closed = false
  let wakeNotifications: (() => void) | undefined
  let open: ((by: string) => void) | undefined
  const openedBy: string[] = []
  const endpoint: CliRpcEndpoint = {
    async handle(message: JsonRpcMessage) {
      const m = message as Wire
      const label = m.method ?? `response:${String(m.id)}`
      handled.push(m.method === 'session/prompt' ? `session/prompt#${String(m.id)}` : label)
      if (m.method === 'session/cancel') open?.('cancel')
      if (o.awaitS2c !== undefined && m.method === undefined && m.id === o.awaitS2c) open?.('s2c-response')
      if (m.method === 'session/prompt') {
        // daemon acp.ts:304-307: a second prompt while one is in flight is refused as busy.
        if (open)
          return {
            jsonrpc: '2.0',
            id: m.id as number,
            error: { code: -32002, message: 'busy', data: { code: 'SESSION_BUSY' } },
          } as JsonRpcMessage
        const by = await new Promise<string>((resolve) => {
          const timer = setTimeout(() => resolve('fallback'), FALLBACK_MS)
          open = (reason) => {
            clearTimeout(timer)
            resolve(reason)
          }
          if (closed) open('close')
        })
        open = undefined
        openedBy.push(by)
        return {
          jsonrpc: '2.0',
          id: m.id as number,
          result: { stopReason: by === 'fallback' ? 'end_turn' : 'cancelled', openedBy: by },
        } as JsonRpcMessage
      }
      if (m.method !== undefined && m.id !== undefined)
        return { jsonrpc: '2.0', id: m.id as number, result: {} } as JsonRpcMessage
      return undefined
    },
    notifications: {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            closed
              ? Promise.resolve({ done: true, value: undefined as never })
              : new Promise<IteratorResult<JsonRpcMessage>>((resolve) => {
                  wakeNotifications = () => resolve({ done: true, value: undefined as never })
                }),
        }
      },
    },
    async close() {
      closed = true
      open?.('close')
      wakeNotifications?.()
    },
  }
  return { endpoint, handled, openedBy, isClosed: () => closed }
}

const collect = (stream: PassThrough): (() => Wire[]) => {
  let text = ''
  stream.on('data', (chunk) => {
    text += String(chunk)
  })
  return () =>
    text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Wire)
}

const line = (message: Record<string, unknown>): string =>
  `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`
const PROMPT = (id: number) =>
  line({ id, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'hi' }] } })
const CANCEL = line({ method: 'session/cancel', params: { sessionId: 's1' } })

describe('DBH M-01 control: the harness itself works', () => {
  it('control: a cancel with no prompt in flight reaches handle, EOF closes the endpoint', async () => {
    const s = stubEndpoint()
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const out = collect(stdout)
    const running = pump({ endpoint: s.endpoint, stdin, stdout, stderr: new PassThrough() })
    stdin.write(CANCEL)
    await vi.waitFor(() => expect(s.handled).toContain('session/cancel'), { timeout: 500 })
    stdin.end(line({ id: 7, method: 'initialize', params: {} }))
    await running
    expect(out().find((m) => m.id === 7)?.result).toEqual({})
    expect(s.isClosed()).toBe(true)
  })

  it('control: a prompt with no cancel ends via fallback and its response is written', async () => {
    const s = stubEndpoint()
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const out = collect(stdout)
    const running = pump({ endpoint: s.endpoint, stdin, stdout, stderr: new PassThrough() })
    stdin.end(PROMPT(1))
    await running
    expect(s.openedBy).toEqual(['fallback'])
    expect(out().find((m) => m.id === 1)?.result).toMatchObject({ stopReason: 'end_turn' })
  })
})

describe('DBH M-01: frames written during an in-flight prompt', () => {
  it('session/cancel written mid-prompt reaches endpoint.handle while the prompt is still running', async () => {
    const s = stubEndpoint()
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const out = collect(stdout)
    const running = pump({ endpoint: s.endpoint, stdin, stdout, stderr: new PassThrough() })
    stdin.write(PROMPT(1))
    await vi.waitFor(() => expect(s.handled).toContain('session/prompt#1'), { timeout: 500 })
    stdin.write(CANCEL)
    await vi.waitFor(() => expect(s.openedBy.length).toBe(1), { timeout: FALLBACK_MS + 1_000 })
    stdin.end()
    await running
    // Correct: the in-flight turn is ended by the cancel. Defect: the cancel is chained behind the
    // prompt's handle(), so the turn can only end by the fallback timer.
    expect(s.openedBy, `handled order: ${s.handled.join(' -> ')}`).toEqual(['cancel'])
    expect(out().find((m) => m.id === 1)?.result).toMatchObject({ stopReason: 'cancelled' })
  }, 10_000)

  it('an s2c response frame (session/request_permission answer) reaches handle mid-prompt', async () => {
    const s = stubEndpoint({ awaitS2c: 's2c-1' })
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    collect(stdout)
    const running = pump({ endpoint: s.endpoint, stdin, stdout, stderr: new PassThrough() })
    stdin.write(PROMPT(1))
    await vi.waitFor(() => expect(s.handled).toContain('session/prompt#1'), { timeout: 500 })
    stdin.write(line({ id: 's2c-1', result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } }))
    await vi.waitFor(() => expect(s.openedBy.length).toBe(1), { timeout: FALLBACK_MS + 1_000 })
    stdin.end()
    await running
    expect(s.openedBy, `handled order: ${s.handled.join(' -> ')}`).toEqual(['s2c-response'])
  }, 10_000)

  // Revised during the M-01 fix: the original form asserted that a second prompt written mid-turn is
  // never dispatched. Design §8 (:146) instead requires it to reach the endpoint and be refused as
  // busy, so that assertion encoded the defect. "Undispatched frames stay undispatched after
  // cancellation" is covered in acp.test.ts with a frame held behind an unsettled initialize.
  it('a second prompt mid-turn is refused as busy, and abort ends the in-flight turn promptly', async () => {
    const s = stubEndpoint()
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const out = collect(stdout)
    const abort = new AbortController()
    const running = pump({
      endpoint: s.endpoint,
      stdin,
      stdout,
      stderr: new PassThrough(),
      signal: abort.signal,
    })
    stdin.write(PROMPT(1))
    await vi.waitFor(() => expect(s.handled).toContain('session/prompt#1'), { timeout: 500 })
    stdin.write(PROMPT(2))
    await vi.waitFor(() => expect(out().find((m) => m.id === 2)?.error).toBeDefined(), { timeout: 500 })
    expect(s.openedBy).toEqual([])
    const t0 = performance.now()
    abort.abort(new Error('dbh cancellation'))
    await running
    const elapsed = performance.now() - t0
    const handled = [...s.handled]
    stdin.destroy()
    expect(
      // Either a pump-issued session/cancel or endpoint.close() is an acceptable way to end the turn.
      {
        elapsedUnder1s: elapsed < 1_000,
        turnEndedByShutdown: s.openedBy[0] === 'close' || s.openedBy[0] === 'cancel',
      },
      `elapsed=${elapsed.toFixed(0)}ms handled=${handled.join(' -> ')} openedBy=${s.openedBy.join(',')}`,
    ).toEqual({ elapsedUnder1s: true, turnEndedByShutdown: true })
  }, 10_000)
})
