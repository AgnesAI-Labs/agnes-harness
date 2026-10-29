import { METHODS } from '@agnes/protocol'
import { createClient } from '@agnes/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { apiCommand, apiHelp, apiRefusal, callableMethods, closestMethods } from '../src/commands/api.js'
import { UsageError } from '../src/errors.js'
import { FakeEndpoint } from './fake-endpoint.js'

// `--params -` reads fd 0; the command's only synchronous stdin read is replaced for this file.
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

const rpcFailure = (code: string) =>
  Object.assign(new Error(`${code} says no`), { code: -32603, data: { code } })

async function run(argv: string[], replies: Record<string, (params: unknown) => unknown> = {}) {
  const endpoint = new FakeEndpoint().on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
  for (const [method, reply] of Object.entries(replies)) endpoint.on(method, reply)
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  clients.push(client)
  let out = ''
  let err = ''
  const exit = await apiCommand(parseArgs(['api', ...argv]), client, {
    stdout: { write: (t: string) => (out += t) } as never,
    stderr: { write: (t: string) => (err += t) } as never,
  })
  const sent = endpoint.calls.filter((c) => c.method.startsWith('_agnes/v1/')).map((c) => c.method)
  return { exit, out, err, sent, endpoint }
}

describe('api command', () => {
  it('calls a client method with and without the prefix and prints the result', async () => {
    const list = { '_agnes/v1/session.list': () => ({ items: [] }) }
    const a = await run(['session.list', '--params', '{"limit":5}'], list)
    expect(a.exit).toBe(0)
    expect(JSON.parse(a.out)).toEqual({ items: [] })
    expect(a.endpoint.calls.at(-1)).toMatchObject({ params: { limit: 5 } })
    const b = await run(['_agnes/v1/session.list', '--json'], list)
    expect(b.out).toBe('{"items":[]}\n')
  })

  it('reads params from stdin for "-"', async () => {
    stdin.text = '{"limit":2}\n'
    const r = await run(['session.list', '--params', '-'], {
      '_agnes/v1/session.list': () => ({ items: [] }),
    })
    expect(r.exit).toBe(0)
    expect(r.endpoint.calls.at(-1)).toMatchObject({ params: { limit: 2 } })
  })

  it('shows a daemon refusal on stderr and exits 1, for an admin method without an admin connection', async () => {
    const r = await run(['config.get'], {
      '_agnes/v1/config.get': () => {
        throw rpcFailure('ADMIN_REQUIRED')
      },
    })
    expect(r.exit).toBe(1)
    expect(r.err).toMatch(/^error: ADMIN_REQUIRED: /)
    expect(r.out).toBe('')
  })

  it('rejects params that fail the protocol schema without sending anything', async () => {
    await expect(run(['session.rename', '--params', '{}'])).rejects.toThrow(
      /params do not match session\.rename/,
    )
    await expect(run(['session.list', '--params', '{"limit":0}'])).rejects.toThrow(
      /\/limit Expected integer to be greater or equal to 1/,
    )
    await expect(run(['session.list', '--params', '{nope'])).rejects.toThrow('--params is not valid JSON')
  })

  it('names the closest methods for an unknown one and sends nothing', async () => {
    const error = await run(['session.lst']).catch((e: Error) => e)
    expect(error).toBeInstanceOf(UsageError)
    expect((error as Error).message).toMatch(/unknown method session\.lst; closest: .*session\.list/)
  })

  it('refuses streaming, attach and command-class methods before any request', async () => {
    for (const method of [
      'submit',
      'session.attach',
      'session.control',
      'session.undo',
      'session/prompt',
      '_agnes/v1/submit.ack',
    ]) {
      const error = await run([method]).catch((e: Error) => e)
      expect(error).toBeInstanceOf(UsageError)
      expect((error as Error).message).toMatch(/is not callable from agh api/)
    }
  })
})

describe('api refusal table', () => {
  // The exact set the table refuses today. A new protocol method that matches a refusal pattern
  // shows up here as a reviewed change; anything off this list is callable.
  const refused = [
    '_agnes/v1/participant.join',
    '_agnes/v1/participant.leave',
    '_agnes/v1/session.attach',
    '_agnes/v1/session.control',
    '_agnes/v1/session.detach',
    '_agnes/v1/session.fork',
    '_agnes/v1/session.jobs.control',
    '_agnes/v1/session.undo',
    '_agnes/v1/submit',
    '_agnes/v1/submit.ack',
  ]

  it('refuses exactly the pinned requests, plus notifications and ACP lifecycle calls', () => {
    const names = Object.keys(METHODS).filter((m) => apiRefusal(m))
    expect(
      names
        .filter((m) => METHODS[m as keyof typeof METHODS].kind === 'request' && m.startsWith('_agnes/v1/'))
        .sort(),
    ).toEqual(refused)
    expect(names.filter((m) => !m.startsWith('_agnes/v1/')).length).toBeGreaterThan(0)
    for (const m of names.filter((n) => METHODS[n as keyof typeof METHODS].kind === 'notification'))
      expect(apiRefusal(m)).toBeDefined()
  })

  it('refuses a new submit-, attach- or subscribe-class method by default but not a plain admin call', () => {
    for (const name of [
      'submit.retry',
      'submit.batch',
      'session.subscribe',
      'session.stream',
      'session.rewind.control',
    ])
      expect(apiRefusal(`_agnes/v1/${name}`)).toBeDefined()
    expect(apiRefusal('_agnes/v1/plugins.candidates.submit')).toBeUndefined()
    expect(apiRefusal('_agnes/v1/schedules.control')).toBeUndefined()
    expect(apiRefusal('_agnes/v1/session.undo.preview')).toBeUndefined()
  })

  it('generates the help list from the protocol table: every callable method, no refused one', () => {
    const listed = apiHelp()
      .split('\n')
      .filter((line) => line.startsWith('  '))
      .map((line) => line.trim().split(/\s+/).join(' '))
    const callable = callableMethods()
    expect(callable.length).toBeGreaterThan(100)
    expect(listed).toEqual(callable.map(({ method, tier }) => `${method.slice('_agnes/v1/'.length)} ${tier}`))
    for (const method of refused) expect(listed.map((l) => l.split(' ')[0])).not.toContain(method.slice(10))
    expect(closestMethods('session.lst')).toContain('session.list')
  })
})
