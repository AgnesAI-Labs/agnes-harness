import { createClient } from '@agnes/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { agentsCommand } from '../src/commands/agents.js'
import { FakeEndpoint } from './fake-endpoint.js'

const clients: Array<ReturnType<typeof createClient>> = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
})

const meta = (n: number, extra: Record<string, unknown> = {}) => ({
  sessionId: `s${String(n).padStart(3, '0')}`,
  createdAt: '2026-10-22T00:00:00.000Z',
  lastSeq: n,
  generation: 0,
  preset: null,
  title: `title ${n}`,
  ...extra,
})
const rpcFailure = (code: string) => Object.assign(new Error(code), { code: -32603, data: { code } })
const idle = { controls: { cancel: true }, paused: false, pending: [] }

async function run(
  argv: string[],
  sessions: ReturnType<typeof meta>[],
  controls: (id: string) => unknown,
  pageSize = 100,
) {
  const endpoint = new FakeEndpoint().on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
  endpoint.on('_agnes/v1/session.list', (params) => {
    const { cursor, limit = 50 } = params as { cursor?: string; limit?: number }
    const from = cursor ? Number(cursor) : 0
    const size = Math.min(limit, pageSize)
    const items = sessions.slice(from, from + size)
    return { items, ...(from + size < sessions.length ? { next: String(from + size) } : {}) }
  })
  let inFlight = 0
  let peak = 0
  endpoint.on('_agnes/v1/session.controls', async (params) => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise((done) => setTimeout(done, 2))
    try {
      return controls((params as { sessionId: string }).sessionId)
    } finally {
      inFlight--
    }
  })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  clients.push(client)
  let out = ''
  const exit = await agentsCommand(parseArgs(['agents', ...argv]), client, {
    stdout: { write: (t: string) => (out += t) } as never,
    stderr: { write: () => true } as never,
  })
  return { exit, out, peak, endpoint }
}

describe('agents command', () => {
  it('derives the state per session and degrades one failed read to unknown', async () => {
    const sessions = [
      meta(1),
      meta(2),
      meta(3),
      meta(4),
      meta(5, { archived: true }),
      meta(6, { loop: { id: 'base/code', version: '1.0.0' } }),
    ]
    const r = await run(['--json'], sessions, (id) => {
      if (id === 's002') return { ...idle, paused: true }
      if (id === 's003')
        return { ...idle, pending: [{ itemId: 'a', target: 'next-turn', kind: 'follow_up', content: [] }] }
      if (id === 's004') throw rpcFailure('SESSION_NOT_FOUND')
      if (id === 's006') throw rpcFailure('FORBIDDEN')
      return idle
    })
    const body = JSON.parse(r.out) as { items: Array<Record<string, unknown>>; truncated: boolean }
    expect(body.truncated).toBe(false)
    expect(body.items.map((i) => [i.key, i.state, i.queued])).toEqual([
      ['s001', 'open', 0],
      ['s002', 'paused', 0],
      ['s003', 'queued', 1],
      ['s004', 'closed', 0],
      ['s006', 'unknown', null],
    ])
    expect(body.items[4]).toMatchObject({ loop: 'base/code@1.0.0', title: 'title 6' })
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(
      ['cwd', 'key', 'lastActivity', 'loop', 'queued', 'state', 'title'].sort(),
    )
  })

  it('caps at 50 across pages by default, reads at most 8 at once, and --all lifts the cap', async () => {
    const sessions = Array.from({ length: 130 }, (_, i) => meta(i + 1))
    const capped = await run(['--json'], sessions, () => idle, 40)
    const body = JSON.parse(capped.out) as { items: unknown[]; truncated: boolean }
    expect(body.items).toHaveLength(50)
    expect(body.truncated).toBe(true)
    expect(capped.peak).toBeGreaterThan(1)
    expect(capped.peak).toBeLessThanOrEqual(8)
    const all = await run(['--all', '--json'], sessions, () => idle, 40)
    expect(JSON.parse(all.out)).toMatchObject({ truncated: false })
    expect((JSON.parse(all.out) as { items: unknown[] }).items).toHaveLength(130)
  })

  it('prints an aligned table in text mode', async () => {
    const r = await run([], [meta(1), meta(2)], () => idle)
    const lines = r.out.trimEnd().split('\n')
    expect(lines[0]).toMatch(/^KEY\s+TITLE\s+LOOP\s+STATE\s+QUEUED\s+LAST ACTIVITY$/)
    expect(lines).toHaveLength(3)
    expect(lines[1]).toMatch(/^s001\s+title 1\s+-\s+open\s+0\s+2026-10-22/)
  })
})
