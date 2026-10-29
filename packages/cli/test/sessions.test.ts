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
  it.each(['verified', 'failed'] as const)(
    'reports %s audits through the SDK with an appropriate exit code',
    async (state) => {
      const endpoint = new FakeEndpoint()
        .on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
        .on('_agnes/v1/session.integrity', (params) => {
          expect(params).toEqual({ sessionId: 'k', verify: true })
          return {
            state,
            lastSeq: 50,
            verifiedThroughSeq: state === 'verified' ? 50 : 0,
            legacyThroughSeq: 0,
            ...(state === 'failed' ? { failureSeq: 10 } : { verifiedAtMs: 1000 }),
          }
        })
      const client = createClient({ transport: { kind: 'inproc', endpoint } })
      clients.push(client)
      const writes: string[] = []
      const code = await sessionsCommand(parseArgs(['sessions', 'verify', 'k', '--json']), client, {
        stdout: { write: (value: string) => writes.push(value) } as never,
        stderr: { write: () => true } as never,
      })
      expect(code).toBe(state === 'verified' ? 0 : 1)
      expect(JSON.parse(writes.join(''))).toMatchObject({ state })
    },
  )

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

  it('list --archived keeps only archived sessions; columns 4-7 are pinned or -, last activity, cwd and the inert title', async () => {
    const items = [
      { ...target, sessionId: 'a', archived: true },
      { ...target, sessionId: 'b', pinnedAt: '2026-09-12T00:00:00Z', lastMessageAt: '2026-09-13T08:00:00Z' },
    ]
    const title = 'red[31m title second line'
    expect((await run(['sessions', 'list', '--archived'], items)).out).toBe(
      `a\t4\tstandard\t-\t2026-09-12T00:00:00Z\t/w\t${title}\n`,
    )
    const listed = (await run(['sessions', 'list'], items)).out
    expect(listed).toBe(
      `a\t4\tstandard\t-\t2026-09-12T00:00:00Z\t/w\t${title}\nb\t4\tstandard\tpinned\t2026-09-13T08:00:00Z\t/w\t${title}\n`,
    )
    // The title is one inert line: no control character and no extra row survives.
    expect(listed.split('\n')).toHaveLength(3)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence is the point
    expect(listed).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/)
  })

  // --limit / --all / --last over a two-page index; `calls` records every session.list request.
  const paged = async (argv: string[], pages: Record<string, { items: unknown[]; next?: string }>) => {
    const calls: unknown[] = []
    const endpoint = new FakeEndpoint()
    endpoint
      .on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .on('_agnes/v1/session.list', (params) => {
        calls.push(params)
        return pages[(params as { cursor?: string }).cursor ?? ''] ?? { items: [] }
      })
    const client = createClient({ transport: { kind: 'inproc', endpoint } })
    clients.push(client)
    let out = ''
    let err = ''
    const exit = await sessionsCommand(parseArgs(argv), client, {
      stdout: { write: (text: string) => (out += text) } as never,
      stderr: { write: (text: string) => (err += text) } as never,
    }).catch((e: Error) => e.message)
    return { exit, out, err, calls }
  }
  const row = (id: string, at: string) => ({ ...target, sessionId: id, createdAt: at })
  const twoPages = {
    '': { items: [row('a', '2026-09-01T00:00:00Z'), row('b', '2026-09-03T00:00:00Z')], next: 'c1' },
    c1: { items: [row('c', '2026-09-02T00:00:00Z'), row('d', '2026-09-09T00:00:00Z')] },
  }
  const ids = (out: string) => JSON.parse(out) as { items: Array<{ sessionId: string }>; next?: string }

  it('list pages: one page with a stderr hint by default, --limit sets the page size, bad values are usage errors', async () => {
    const one = await paged(['sessions', 'list', '--json'], twoPages)
    expect(one.calls).toEqual([{ limit: 50 }])
    expect(ids(one.out).next).toBe('c1')
    expect(one.err).toContain('--all')
    expect((await paged(['sessions', 'list', '--limit', '7'], twoPages)).calls).toEqual([{ limit: 7 }])
    for (const bad of ['0', '501', 'x', '1.5'])
      expect((await paged(['sessions', 'list', '--limit', bad], twoPages)).exit).toMatch(/--limit expects/)
  })

  it.each([
    [['--all'], ['a', 'b', 'c', 'd'], [{ limit: 500 }, { limit: 500, cursor: 'c1' }]],
    [
      ['--all', '--limit', '3'],
      ['a', 'b', 'c'],
      [{ limit: 3 }, { limit: 1, cursor: 'c1' }],
    ],
    [['--last'], ['d'], [{ limit: 500 }, { limit: 500, cursor: 'c1' }]],
  ])('list %j reads every page it needs and prints %j', async (flags, want, calls) => {
    const r = await paged(['sessions', 'list', ...flags, '--json'], twoPages)
    expect(ids(r.out).items.map((i) => i.sessionId)).toEqual(want)
    expect(ids(r.out).next).toBeUndefined()
    expect(r.calls).toEqual(calls)
    expect(r.err).toBe('')
  })

  it('--all stops on a cursor that does not advance instead of looping', async () => {
    const loop = {
      '': { items: [row('a', '2026-09-01T00:00:00Z')], next: 'c1' },
      c1: { items: [], next: 'c1' },
    }
    const r = await paged(['sessions', 'list', '--all', '--json'], loop)
    expect(r.calls).toHaveLength(2)
    expect(ids(r.out).items.map((i) => i.sessionId)).toEqual(['a'])
  })

  // One row per verb: which RPC runs with which params, and what the user sees.
  const manage = async (argv: string[], method: string, reply: unknown | Error) => {
    const endpoint = new FakeEndpoint()
    endpoint
      .on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .on(method, () => {
        if (reply instanceof Error) throw reply
        return reply
      })
    const client = createClient({ transport: { kind: 'inproc', endpoint } })
    clients.push(client)
    let out = ''
    const promise = sessionsCommand(parseArgs(argv), client, {
      stdout: { write: (text: string) => (out += text) } as never,
      stderr: { write: () => true } as never,
    })
    const exit = await promise.catch((e: Error) => e)
    return { exit, out, params: endpoint.calls.find((c) => c.method === method)?.params }
  }

  it.each([
    [
      ['sessions', 'pin', 's1'],
      'session.pin',
      { sessionId: 's1', pinned: true },
      { archived: false, pinnedAt: '2026-09-12T00:00:00Z' },
      's1: pinned\n',
    ],
    [
      ['sessions', 'unpin', 's1'],
      'session.pin',
      { sessionId: 's1', pinned: false },
      { archived: false },
      's1: unpinned\n',
    ],
    [
      ['sessions', 'archive', 's1'],
      'session.archive',
      { sessionId: 's1', archived: true },
      { archived: true },
      's1: archived\n',
    ],
    [
      ['sessions', 'unarchive', 's1'],
      'session.archive',
      { sessionId: 's1', archived: false },
      { archived: false },
      's1: unarchived\n',
    ],
    [
      ['sessions', 'rename', 's1', 'two', 'words'],
      'session.rename',
      { sessionId: 's1', title: 'two words' },
      { archived: false, title: 'two words' },
      's1: title two words\n',
    ],
  ])('%j calls %s and confirms in one line', async (argv, method, params, reply, text) => {
    const r = await manage(argv, `_agnes/v1/${method}`, reply)
    expect(r.exit).toBe(0)
    expect(r.params).toEqual(params)
    expect(r.out).toBe(text)
    expect((await manage([...argv, '--json'], `_agnes/v1/${method}`, reply)).out).toBe(
      `${JSON.stringify(reply)}\n`,
    )
  })

  it('groups lists daemon groups, search groups hits per session on inert lines', async () => {
    const g = await manage(['sessions', 'groups'], '_agnes/v1/session.groups', {
      ready: true,
      items: [{ groupId: 'pinned', total: 2, lastMessageAt: null, revision: 'r', ready: true }],
    })
    expect(g.out).toBe('pinned\t2\t-\n')
    const hit = { sessionId: 's1', title: 'T\u001b[31m', workspace: '/w', snippet: 'a\nb', ts: '2026-09-12' }
    const r = await manage(['sessions', 'search', 'foo', 'bar'], '_agnes/v1/admin.history.search', {
      items: [hit, hit],
      truncated: false,
    })
    expect(r.params).toEqual({ query: 'foo bar', title: '', workspace: '' })
    expect(r.out).toBe('s1\tT[31m\t/w\n  2026-09-12  a b\n  2026-09-12  a b\n')
  })

  it('shows a daemon refusal as it comes and rejects missing arguments', async () => {
    const denied = Object.assign(new Error('admin tier required'), {
      code: -32006,
      data: { code: 'FORBIDDEN' },
    })
    const r = await manage(['sessions', 'search', 'x'], '_agnes/v1/admin.history.search', denied)
    expect(r.exit).toBeInstanceOf(Error)
    expect((r.exit as Error).message).toContain('admin tier required')
    for (const argv of [
      ['sessions', 'pin'],
      ['sessions', 'rename', 's1'],
      ['sessions', 'search'],
    ])
      expect((await manage(argv, '_agnes/v1/session.pin', {})).exit).toBeInstanceOf(Error)
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
