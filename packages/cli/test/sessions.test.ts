import { createClient } from '@agnes/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { runPluginDevelopmentCommand } from '../src/commands/plugins.js'
import { sessionsCommand } from '../src/commands/sessions.js'
import { FakeEndpoint } from './fake-endpoint.js'

const clients: Array<Awaited<ReturnType<typeof createClient>>> = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
})

describe('sessions command', () => {
  it('uses the SDK list surface and filters show to the exact requested id', async () => {
    const endpoint = new FakeEndpoint()
    let params: unknown
    endpoint
      .on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .on('_agnes/v1/session.list', (received) => {
        params = received
        return {
          items: [
            {
              sessionId: 'agnes:target',
              createdAt: '2026-09-12T00:00:00Z',
              lastSeq: 4,
              generation: 1,
              preset: 'standard',
            },
            {
              sessionId: 'agnes:target-child',
              createdAt: '2026-09-12T00:00:00Z',
              lastSeq: 8,
              generation: 1,
              preset: 'standard',
            },
          ],
        }
      })
    const client = createClient({ transport: { kind: 'inproc', endpoint } })
    clients.push(client)
    const writes: string[] = []
    const exit = await sessionsCommand(
      parseArgs(['sessions', 'show', 'agnes:target', '--cwd', '/w', '--json']),
      client,
      {
        stdout: { write: (text: string) => writes.push(text) } as never,
        stderr: { write: () => true } as never,
      },
    )

    expect(exit).toBe(0)
    expect(params).toEqual({ limit: 500, q: { text: 'agnes:target', cwd: '/w' } })
    expect(JSON.parse(writes.join(''))).toMatchObject({ items: [{ sessionId: 'agnes:target' }] })
  })

  // F03: `show` printed the same one line as `list`, and an id that matched nothing said
  // "no sessions" and exited 0, so a script could not tell a typo from success.
  const run = async (argv: string[], items: unknown[]) => {
    const endpoint = new FakeEndpoint()
    endpoint
      .on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .on('_agnes/v1/session.list', () => ({ items }))
    const client = createClient({ transport: { kind: 'inproc', endpoint } })
    clients.push(client)
    let out = ''
    let err = ''
    const exit = await sessionsCommand(parseArgs(argv), client, {
      stdout: { write: (text: string) => (out += text) } as never,
      stderr: { write: (text: string) => (err += text) } as never,
    })
    return { exit, out, err }
  }
  const target = {
    sessionId: 'agnes:target',
    parent: 'agnes:root',
    createdAt: '2026-09-12T00:00:00Z',
    lastSeq: 4,
    generation: 1,
    preset: 'standard',
    title: 'red\u001b[31m title\nsecond line',
    cwd: '/w',
  }

  it('show prints one detail row per field, with model-written text kept to one inert line', async () => {
    const { exit, out, err } = await run(['sessions', 'show', 'agnes:target'], [target])
    expect(exit).toBe(0)
    expect(err).toBe('')
    expect(out).toBe(
      [
        'id       agnes:target',
        'parent   agnes:root',
        'title    red[31m title second line',
        'cwd      /w',
        'created  2026-09-12T00:00:00Z',
        'lastSeq  4',
        'preset   standard',
        'archived no',
        '',
      ].join('\n'),
    )
  })

  it('show fails with a named id on stderr and exit 1 when nothing matches, in text and --json alike', async () => {
    for (const argv of [
      ['sessions', 'show', 'agnes:missing'],
      ['sessions', 'show', 'agnes:missing', '--json'],
    ]) {
      const { exit, out, err } = await run(argv, [{ ...target, sessionId: 'agnes:missing-child' }])
      expect(exit).toBe(1)
      expect(out).toBe('')
      expect(err).toBe('no session agnes:missing\n')
    }
  })

  it('list with nothing to show still succeeds', async () => {
    expect(await run(['sessions', 'list'], [])).toEqual({ exit: 0, out: 'no sessions\n', err: '' })
  })
})

it('routes migration and publication status through the Node SDK with the selected profile', async () => {
  const endpoint = new FakeEndpoint()
  const migration = {
    previousGenerationId: '11111111-1111-4111-8111-111111111111',
    generationId: '22222222-2222-4222-8222-222222222222',
    changed: true,
  }
  const status = {
    publication: {
      operation: 'models',
      ok: false,
      recovery: 'retry-same-input',
      containers: [
        { compositionHash: 'reader', status: 'applied' },
        { compositionHash: 'writer', status: 'failed' },
      ],
    },
  }
  let received: unknown
  endpoint
    .on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
    .on('_agnes/v1/sessions.migrate', (params) => {
      received = params
      return migration
    })
    .on('_agnes/v1/plugins.publicationStatus', (params) => {
      received = params
      return status
    })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  clients.push(client)
  let out = ''
  await sessionsCommand(
    parseArgs(['sessions', 'migrate', 'closed', '--profile', 'review', '--json']),
    client,
    {
      stdout: {
        write: (text: string) => {
          out += text
        },
      } as never,
      stderr: { write: () => true } as never,
    },
  )
  expect(JSON.parse(out)).toEqual(migration)
  expect(received).toMatchObject({
    profile: 'review',
    sessionId: 'closed',
    commandId: expect.any(String),
    clientId: await client.clientId(),
  })
  out = ''
  await runPluginDevelopmentCommand(
    parseArgs(['plugins', 'publication-status', '--profile', 'review', '--json']),
    client,
    (text) => {
      out += text
    },
  )
  expect(received).toEqual({ profile: 'review' })
  expect(JSON.parse(out)).toEqual(status)
  await expect(sessionsCommand(parseArgs(['sessions', 'migrate']), client, {} as never)).rejects.toThrow(
    'expects <key>',
  )
  await expect(
    runPluginDevelopmentCommand(parseArgs(['plugins', 'publication-status', 'extra']), client, () => {}),
  ).rejects.toThrow('takes no arguments')
})
