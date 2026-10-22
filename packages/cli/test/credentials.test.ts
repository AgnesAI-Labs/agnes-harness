import { createClient } from '@agnes/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { credentialsCommand } from '../src/commands/credentials.js'
import { FakeEndpoint } from './fake-endpoint.js'

const clients: Array<Awaited<ReturnType<typeof createClient>>> = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
})

const ID = 'secret://generic/11111111-2222-3333-4444-555555555555'
const USED = 'secret://generic/66666666-7777-8888-9999-000000000000'
const PLAINTEXT = 'sk-live-PLAINTEXT-NEVER-PRINT'
const item = (id: string, label: string, references: unknown[] = []) => ({
  id,
  label,
  kind: 'api-key',
  createdAt: '2026-10-22T00:00:00.000Z',
  references,
})
const ref = { kind: 'mcp', profile: 'p', configId: 'github' }
// A misbehaving daemon: extra secret-looking fields. The SDK's result schema refuses them before the
// command sees them; the command also rebuilds every item field by field.
const leaky = (m: ReturnType<typeof item>) => ({
  ...m,
  value: PLAINTEXT,
  apiKey: PLAINTEXT,
  secret: PLAINTEXT,
})

async function run(argv: string[], handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
  const endpoint = new FakeEndpoint().on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
  for (const [method, h] of Object.entries(handlers))
    endpoint.on(`_agnes/v1/admin.credentials.${method}`, (params) => h(params as Record<string, unknown>))
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  clients.push(client)
  let out = ''
  let err = ''
  const exit = await credentialsCommand(parseArgs(['credentials', ...argv]), client, {
    stdout: { write: (t: string) => (out += t) } as never,
    stderr: { write: (t: string) => (err += t) } as never,
  }).catch((e: Error) => e)
  return {
    exit,
    out,
    err,
    calls: endpoint.calls
      .filter((c) => c.method.startsWith('_agnes/v1/admin.credentials.'))
      .map((c) => [c.method.split('.').pop(), c.params]),
  }
}

const items = [item(ID, 'work'), item(USED, 'ci', [ref])]
const list = { list: () => ({ items }) }
const leakyList = { list: () => ({ items: items.map(leaky) }) }

describe('credentials command', () => {
  it('list prints metadata lines only, in text and --json', async () => {
    const r = await run(['list'], list)
    expect(r.exit).toBe(0)
    expect(r.out).toBe(
      `${ID}\twork\tapi-key\t2026-10-22T00:00:00.000Z\tunused\n${USED}\tci\tapi-key\t2026-10-22T00:00:00.000Z\tused by mcp:github\n`,
    )
    expect((await run([], list)).out).toBe(r.out)
    const j = await run(['list', '--json'], list)
    expect(JSON.parse(j.out)).toEqual({ items })
    for (const text of [r.out, j.out, r.err, j.err]) expect(text).not.toContain(PLAINTEXT)
    expect((await run(['list'], { list: () => ({ items: [] }) })).out).toBe('no credentials\n')
    // secret-looking fields from the daemon: refused with the field name, never the value
    for (const argv of [['list'], ['list', '--json'], ['delete', ID]]) {
      const bad = await run(argv, leakyList)
      expect(bad.exit).toBeInstanceOf(Error)
      expect(`${bad.out}${bad.err}${(bad.exit as Error).message}`).not.toContain(PLAINTEXT)
      expect(bad.out).toBe('')
    }
  })

  it('rename sends id and label and prints the metadata only', async () => {
    const handlers = { rename: () => item(ID, 'new name') }
    const r = await run(['rename', ID, 'new', 'name'], handlers)
    expect(r.calls).toEqual([['rename', { id: ID, label: 'new name' }]])
    expect(r.out).toContain('renamed')
    expect(r.out).not.toContain(PLAINTEXT)
    const j = await run(['rename', ID, 'x', '--json'], handlers)
    expect(j.out).not.toContain(PLAINTEXT)
    expect(JSON.parse(j.out)).toEqual(item(ID, 'new name'))
    expect(((await run(['rename', ID], handlers)).exit as Error).constructor.name).toBe('UsageError')
  })

  it('delete without --yes shows the target and sends nothing; with --yes it deletes', async () => {
    const handlers = { ...list, delete: () => ({}) }
    const dry = await run(['delete', ID], handlers)
    expect(dry.exit).toBe(0)
    expect(dry.calls).toEqual([['list', {}]])
    expect(dry.out).toContain('would delete')
    expect(dry.out).toContain('nothing was deleted')
    expect(dry.out).not.toContain(PLAINTEXT)
    expect((await run(['delete', ID, '--json'], handlers)).out).not.toContain(PLAINTEXT)
    const missing = await run(['delete', 'secret://generic/nope'], handlers)
    expect(missing.exit).toBe(1)
    expect(missing.calls).toEqual([['list', {}]])

    const done = await run(['delete', ID, '--yes'], handlers)
    expect(done.calls).toEqual([['delete', { id: ID }]])
    expect(done.out).toBe(`deleted ${ID}\n`)
    const forced = await run(['delete', USED, '--yes', '--force'], handlers)
    expect(forced.calls).toEqual([['delete', { id: USED, force: true, confirm: true }]])
    expect(((await run(['delete', ID, '--force'], handlers)).exit as Error).constructor.name).toBe(
      'UsageError',
    )
  })

  it('a daemon refusal propagates and unknown actions are usage errors', async () => {
    const r = await run(['delete', USED, '--yes'], {
      delete: () => {
        throw Object.assign(new Error('CONFIG_CREDENTIAL_REFERENCED'), { code: -32000 })
      },
    })
    expect((r.exit as Error).message).toContain('CONFIG_CREDENTIAL_REFERENCED')
    expect(((await run(['create'], {})).exit as Error).constructor.name).toBe('UsageError')
  })
})
