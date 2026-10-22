import { createClient } from '@agnes/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { queueCommand } from '../src/commands/queue.js'
import { UsageError } from '../src/errors.js'
import { FakeEndpoint } from './fake-endpoint.js'

// `-` reads fd 0; the command's only synchronous stdin read is replaced for this file.
const stdin = vi.hoisted(() => ({ text: '' }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  const readFileSync = (path: unknown, ...rest: unknown[]) =>
    path === 0 ? stdin.text : (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)
  return { ...actual, readFileSync }
})

const clients: Array<ReturnType<typeof createClient>> = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
})

const rpcFailure = (code: string) => Object.assign(new Error(code), { code: -32603, data: { code } })

async function run(argv: string[], submit: (params: Record<string, unknown>) => unknown) {
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
    .on('session/load', () => ({}))
    .on('_agnes/v1/submit.ack', () => ({}))
    .on('_agnes/v1/submit', (params) => submit(params as Record<string, unknown>))
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  clients.push(client)
  let out = ''
  let err = ''
  const exit = await queueCommand(parseArgs(['queue', ...argv]), client, {
    stdout: { write: (t: string) => (out += t) } as never,
    stderr: { write: (t: string) => (err += t) } as never,
  })
  const submits = endpoint.calls.filter((c) => c.method === '_agnes/v1/submit').map((c) => c.params as never)
  return { exit, out, err, submits, journal: await client.journal.pending('s1') }
}

const sent = (submits: Array<{ kind: string; payload: { sessionId: string; content: unknown } }>) =>
  submits.map((s) => [s.kind, s.payload.sessionId, s.payload.content])

describe('queue command', () => {
  it('sends a follow-up by default and a steer with --steer, through the SDK submit path', async () => {
    const a = await run(['s1', 'then', 'run', 'tests'], () => ({ seq: 7, replayed: false }))
    expect(a.err).toBe('')
    expect(a.exit).toBe(0)
    expect(a.out).toBe('queued followUp (seq 7)\n')
    expect(sent(a.submits)).toEqual([['followUp', 's1', [{ type: 'text', text: 'then run tests' }]]])
    expect(a.journal).toEqual([])
    const b = await run(['s1', '--steer', '--json', 'use', 'sqlite'], () => ({ seq: 8, replayed: false }))
    expect(JSON.parse(b.out)).toEqual({ sessionId: 's1', kind: 'steer', seq: 8 })
    expect(sent(b.submits)).toEqual([['steer', 's1', [{ type: 'text', text: 'use sqlite' }]]])
  })

  it('reads the message from stdin for "-"', async () => {
    stdin.text = 'from stdin\n'
    const r = await run(['s1', '-'], () => ({ seq: 3, replayed: false }))
    expect(r.exit).toBe(0)
    expect(sent(r.submits)).toEqual([['followUp', 's1', [{ type: 'text', text: 'from stdin' }]]])
  })

  it('shows a daemon refusal as it comes and exits 1', async () => {
    const r = await run(['s1', 'hi'], () => {
      throw rpcFailure('FORBIDDEN')
    })
    expect(r.exit).toBe(1)
    expect(r.err).toMatch(/^refused: FORBIDDEN: /)
    expect(r.out).toBe('')
  })

  it('reports an unconfirmed outcome and never sends it again', async () => {
    const r = await run(['s1', 'hi'], () => {
      throw rpcFailure('UNCERTAIN')
    })
    expect(r.exit).toBe(1)
    expect(r.err).toMatch(/^unconfirmed: .*followUp .*agh sessions show s1\n$/)
    expect(r.submits).toHaveLength(1)
    expect(r.journal.map((c) => c.state)).toEqual(['needs-confirmation'])
  })

  it('rejects a missing key, an empty message and --steer on another command', async () => {
    await expect(run(['s1'], () => ({ seq: 1, replayed: false }))).rejects.toBeInstanceOf(UsageError)
    await expect(run(['s1', '  '], () => ({ seq: 1, replayed: false }))).rejects.toBeInstanceOf(UsageError)
    expect(() => parseArgs(['agents', '--steer'])).toThrow(UsageError)
  })
})
