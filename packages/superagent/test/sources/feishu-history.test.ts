// History recovery at its edges: a message at the boundary of two slices, and a skipped window that a later failure of
// the same recovery must not lose.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KV } from '../../src/kv.js'
import { HISTORY_SLICE_MS, recoverRound } from '../../src/sources/feishu-loops.js'
import { message, rpc } from './fake-channels.js'
import { type FeishuHost, feishuHost } from './feishu-host.js'

const hosts: FeishuHost[] = []
const open = (...args: Parameters<typeof feishuHost>) => {
  const host = feishuHost(...args)
  hosts.push(host)
  return host
}
afterEach(() => {
  vi.useRealTimers()
  for (const host of hosts.splice(0)) host.close()
})
const now = Date.parse('2026-11-14T08:00:00.000Z')
const at = (ago: number) => new Date(now - ago).toISOString()
const second = (iso: string) => Math.floor(Date.parse(iso) / 1000)
const round = (h: FeishuHost) =>
  recoverRound(h.ctx, h.link, h.ctx.config('feishu')!, new AbortController().signal)

describe('history recovery at a slice edge', () => {
  it.each([
    ['excludes both ends at second granularity', (t: number, s: number, e: number) => t > s && t < e],
    ['includes both ends at second granularity', (t: number, s: number, e: number) => t >= s && t <= e],
    ['includes the start and excludes the end', (t: number, s: number, e: number) => t >= s && t < e],
  ])(
    'takes in a message at the boundary of two slices once from a channel that %s',
    async (_name, within) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(now)
      const h = open({ feishu: { chats: [{ chatId: 'oc_team', listen: 'mentions' }] } })
      h.link.listening = true
      // Two hours to recover: the edge of the two slices is an hour ago, where the message was written.
      h.ctx.state.set(KV.feishu.history('oc_team'), at(2 * HISTORY_SLICE_MS))
      const edge = message('om_edge', { at: at(HISTORY_SLICE_MS), mentioned: true })
      const reads: { start: string; end: string }[] = []
      h.fake.channels.listHistory = async (_channel, _chat, opts) => {
        reads.push(opts)
        return within(second(edge.at), second(opts.start), second(opts.end)) ? [edge] : []
      }
      await round(h)
      expect(reads).toHaveLength(2)
      expect(h.receive.mock.calls.filter(([trigger]) => trigger.meta.messageId === 'om_edge')).toHaveLength(1)
      expect(h.trigger('om_edge')).toBeDefined()
    },
  )
})

describe('a skipped history window', () => {
  it('stays on the history health when a later slice of the same recovery fails, and in the rounds after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    const hour = HISTORY_SLICE_MS
    const h = open({ feishu: { chats: [{ chatId: 'oc_team', listen: 'mentions' }] } })
    h.link.listening = true
    h.ctx.state.set(KV.feishu.history('oc_team'), at(3 * hour))
    let failing = true
    h.fake.channels.listHistory = async (_channel, _chat, opts) => {
      // The first hour is more than the channel reads at once; the next one fails for another reason, once.
      if (opts.start === at(3 * hour)) throw rpc('SEMANTIC_REJECTED', 'CHANNEL_READ_TOO_LARGE')
      if (opts.start === at(2 * hour) && failing) throw new Error('channel unreachable')
      return []
    }
    await round(h)
    expect(h.health.history).toMatchObject({ state: 'error' })
    expect(h.health.history?.detail).toContain('oc_team: channel unreachable')
    expect(h.health.history?.detail).toContain(`oc_team: skipped ${at(3 * hour)} to ${at(2 * hour)}`)
    // The next round reads on from the skipped hour and recovers the rest; the gap is still reported.
    failing = false
    vi.setSystemTime(now + 60_000)
    await round(h)
    expect(h.health.history).toMatchObject({ state: 'error' })
    expect(h.health.history?.detail).toBe(
      `Listed chats recovered with gaps:\noc_team: skipped ${at(3 * hour)} to ${at(2 * hour)}, more messages than the channel reads at once`,
    )
  })
})
