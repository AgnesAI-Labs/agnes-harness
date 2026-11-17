/** History pages and restart cursors preserve message dedupe and do not advance over failed pages. */
import { afterEach, expect, it, vi } from 'vitest'
import { KV } from '../../src/kv.js'
import { backfillChat, HISTORY_SLICE_MS, recoverRound } from '../../src/sources/feishu-loops.js'
import { fakeCli, IDENTITY, message } from './fake-cli.js'
import { type FeishuHost, feishuHost } from './feishu-host.js'

const hosts: FeishuHost[] = []
const open = (...args: Parameters<typeof feishuHost>) => {
  const h = feishuHost(...args)
  hosts.push(h)
  return h
}
afterEach(() => {
  vi.useRealTimers()
  for (const h of hosts.splice(0)) h.close()
})
const now = Date.parse('2026-11-14T08:00:00Z'),
  iso = (n: number) => new Date(n).toISOString()
const round = (h: FeishuHost) =>
  recoverRound(h.ctx, h.link, h.ctx.config('feishu')!, new AbortController().signal)
it('recovers all pages, overlapping slice edges only once and keeping cursors across restarts', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  const h = open({
    fake: fakeCli({
      history: Array.from({ length: 130 }, (_, n) =>
        message(`om_${n}`, { mentioned: true, at: iso(now - HISTORY_SLICE_MS + n * 1000) }),
      ),
    }),
    feishu: { chats: [{ chatId: 'oc_team', listen: 'mentions' }] },
  })
  const key = KV.feishu.history(`${IDENTITY}:oc_team`)
  h.ctx.state.set(key, iso(now - 2 * HISTORY_SLICE_MS))
  await round(h)
  expect(h.trigger('om_129')).toBeDefined()
  expect(h.receive.mock.calls.filter(([t]) => t.meta.messageId === 'om_0')).toHaveLength(1)
  const before = h.ctx.state.get(key)
  await round(h)
  expect(h.receive).toHaveBeenCalledTimes(130)
  expect(h.ctx.state.get(key)).toBe(before)
})
it('retains the last complete cursor on failed or stalled pages and refuses foreign messages', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  const h = open({ feishu: { chats: [{ chatId: 'oc_team', listen: 'mentions' }] } })
  const key = KV.feishu.history(`${IDENTITY}:oc_team`),
    since = iso(now - 10000)
  h.ctx.state.set(key, since)
  h.fake.lark.mockResolvedValue({ items: [], has_more: true, page_token: 'stuck' })
  await round(h)
  expect(h.ctx.state.get(key)).toBe(since)
  expect(h.health.history?.state).toBe('error')
  h.fake.lark.mockResolvedValue({
    items: [
      {
        message_id: 'om_foreign',
        chat_id: 'oc_other',
        create_time: iso(now),
        sender: { id: 'ou_alice', sender_type: 'user' },
      },
    ],
    has_more: false,
  })
  await expect(
    backfillChat(h.ctx, h.link, 'oc_team', since, iso(now), new AbortController().signal),
  ).rejects.toThrow('outside the requested chat')
  expect(h.trigger('om_foreign')).toBeUndefined()
  // A successful chat page must not skip topic replies when their separate read fails afterwards.
  const pending = open({ feishu: { chats: [{ chatId: 'oc_team', listen: 'mentions' }] } })
  const older = iso(now - 2 * HISTORY_SLICE_MS)
  pending.ctx.state.set(key, older)
  pending.ctx.state.set(KV.feishu.topics(`${IDENTITY}:oc_team`), { omt_pending: older })
  const read = pending.fake.lark.getMockImplementation()!
  pending.fake.lark.mockImplementation(async (args, ...rest) => {
    if (args[1] === '+threads-messages-list') throw new Error('temporary topic failure')
    return read(args, ...rest)
  })
  await round(pending)
  expect(pending.ctx.state.get(key)).toBe(older)
  expect(pending.health.history?.state).toBe('error')
  pending.fake.lark.mockImplementation(read)
  await round(pending)
  expect(Date.parse(pending.ctx.state.get(key)!)).toBeGreaterThan(Date.parse(older))
  expect(pending.health.history?.state).toBe('ready')
})
it('bounds outage recovery to 24 slices and resumes from the last completed slice', async () => {
  const h = open(),
    checkpoints: string[] = []
  const start = now - 30 * HISTORY_SLICE_MS
  const first = await backfillChat(
    h.ctx,
    h.link,
    'oc_team',
    iso(start),
    iso(now),
    new AbortController().signal,
    (at) => checkpoints.push(at),
  )
  expect(first.behind).toBe(iso(start + 24 * HISTORY_SLICE_MS))
  expect(checkpoints.at(-1)).toBe(first.behind)
  const rest = await backfillChat(
    h.ctx,
    h.link,
    'oc_team',
    first.behind!,
    iso(now),
    new AbortController().signal,
  )
  expect(rest.behind).toBeUndefined()
})
