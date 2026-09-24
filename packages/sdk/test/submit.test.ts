import { afterEach, expect, it, vi } from 'vitest'
import { createClient } from '../src/client.js'
import { ProtocolViolation } from '../src/errors.js'
import { memoryJournal, type PendingCommand } from '../src/journal.js'
import { fakeEndpoint, type Handler } from './helpers/fake-endpoint.js'

const clients: ReturnType<typeof createClient>[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
})
async function setup(handler: Handler, journal = memoryJournal('cid')) {
  const f = fakeEndpoint({
    initialize: fakeEndpoint({}).initialize,
    '_agnes/v1/workspace.add': (params) => ({
      workspace: {
        path: (params as { path: string }).path,
        name: 'w',
        lastUsedAt: null,
        sessionCount: 0,
        available: true,
      },
    }),
    'session/new': () => ({ sessionId: 's' }),
    '_agnes/v1/submit': handler,
    '_agnes/v1/submit.ack': () => ({}),
  })
  const client = createClient({ transport: { kind: 'inproc', endpoint: f.endpoint }, journal })
  clients.push(client)
  return { client, f, journal, session: await client.session.new({ cwd: '/w' }) }
}
it('owns input before yielding and persists the exact pending command before wire dispatch', async () => {
  const journal = memoryJournal('cid')
  const s = await setup(async (params) => {
    const pending = await journal.pending('s')
    expect(pending).toEqual([{ commandId: 'cid:s:1', method: '_agnes/v1/submit', params }])
    expect(params).toMatchObject({
      clientId: 'cid',
      kind: 'steer',
      payload: { content: [{ type: 'text', text: 'original' }] },
    })
    return { seq: 9, replayed: false }
  }, journal)
  const input = [{ type: 'text' as const, text: 'original' }]
  const call = s.session.steer(input)
  const first = input[0]
  if (!first) throw new Error('missing test input')
  first.text = 'changed'
  expect(await call).toBe(9)
  expect(await journal.pending('s')).toEqual([])
  expect(s.f.calls.find((entry) => entry.method === '_agnes/v1/submit.ack')?.params).toEqual({
    clientId: 'cid',
    sessionId: 's',
    commandId: 'cid:s:1',
  })
})
it('retains pending on overload and replays the same command then clears it', async () => {
  let fail = true
  const s = await setup(() => {
    if (fail) throw Object.assign(new Error('OVERLOADED'), { code: -32001, data: { code: 'OVERLOADED' } })
    return { seq: 9, replayed: true }
  })
  await expect(s.session.followUp('later')).rejects.toMatchObject({ code: -32001 })
  expect(await s.journal.pending('s')).toHaveLength(1)
  fail = false
  await s.client.resendPending('s')
  const calls = s.f.calls.filter((c) => c.method === '_agnes/v1/submit')
  expect(calls).toHaveLength(2)
  expect(calls[1]?.params).toEqual(calls[0]?.params)
  expect(await s.journal.pending('s')).toEqual([])
})
it('journals fork with one stable child key and accepts a result without a synthetic sequence', async () => {
  const journal = memoryJournal('cid')
  const s = await setup(async (params) => {
    const command = params as {
      kind: string
      payload: { sessionId: string; at: number; childKey: string }
    }
    expect(command).toMatchObject({
      kind: 'fork',
      payload: { sessionId: 's', at: 7, childKey: expect.stringMatching(/^agnes:fork:/) },
    })
    expect(await journal.pending('s')).toHaveLength(1)
    return { replayed: false, result: { sessionId: command.payload.childKey } }
  }, journal)

  const child = await s.client.session.fork('s', 7)
  expect(child.id).toMatch(/^agnes:fork:/)
  expect(await journal.pending('s')).toEqual([])
  expect(s.f.calls.some((call) => call.method === '_agnes/v1/submit.ack')).toBe(true)
})
it.each([{ replayed: false }, { seq: 0, replayed: false }, { seq: 9, replayed: 'no' }])(
  'retains pending on an invalid or incomplete acknowledgement %j',
  async (ack) => {
    const s = await setup(() => ack)
    await expect(s.session.steer('go')).rejects.toBeInstanceOf(ProtocolViolation)
    expect(await s.journal.pending('s')).toHaveLength(1)
  },
)
it('settles an uncertain acknowledgement explicitly without reporting a sequence', async () => {
  const s = await setup(() => ({ replayed: false, status: 'uncertain' }))
  await expect(s.session.steer('go', { commandId: 'stable-id' })).rejects.toMatchObject({
    code: -32603,
    data: { code: 'UNCERTAIN', commandId: 'stable-id' },
  })
  expect(await s.journal.pending('s')).toEqual([])
  expect(s.f.calls.some((entry) => entry.method === '_agnes/v1/submit.ack')).toBe(false)
})
it.each(['method', 'identity', 'session', 'commandId', 'actor'])(
  'rejects journal %s substitution before sending any replay',
  async (kind) => {
    const s = await setup(() => ({ seq: 9, replayed: false }))
    const command: PendingCommand = {
      commandId: 'c',
      method: '_agnes/v1/submit',
      params: {
        clientId: 'cid',
        commandId: 'c',
        kind: 'steer',
        payload: { sessionId: 's', content: [{ type: 'text', text: 'safe' }] },
      },
    }
    const params = command.params as Record<string, unknown>
    if (kind === 'method') command.method = '_agnes/v1/auth.claim'
    if (kind === 'identity') params.clientId = 'other'
    if (kind === 'session') (params.payload as Record<string, unknown>).sessionId = 'other'
    if (kind === 'commandId') params.commandId = 'other'
    if (kind === 'actor') (params.payload as Record<string, unknown>).actor = { kind: 'system' }
    await s.journal.markPending('s', command)
    const before = s.f.calls.length
    await expect(s.client.resendPending('s')).rejects.toBeInstanceOf(ProtocolViolation)
    expect(s.f.calls).toHaveLength(before)
    expect(await s.journal.pending('s')).toHaveLength(1)
  },
)
it('does not send when persistence fails', async () => {
  const s = await setup(() => ({ seq: 9, replayed: false }))
  vi.spyOn(s.journal, 'markPending').mockRejectedValueOnce(new Error('storage unavailable'))
  const before = s.f.calls.length
  await expect(s.session.steer('go')).rejects.toThrow('storage unavailable')
  expect(s.f.calls).toHaveLength(before)
})
