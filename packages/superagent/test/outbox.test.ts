// Adapted from dsh-superagent (MIT)
/** Outbox delivery when processing is paused or a Source kind registers late. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { z } from 'zod'
import { Effects } from '../src/app/effects.js'
import { Outbox } from '../src/app/outbox.js'
import { Store } from '../src/app/store.js'
import type { OutboundMessage } from '../src/core/index.js'
import type { Commands } from '../src/infra/commands.js'
import { HealthBoard } from '../src/infra/health.js'
import { SettingsSchema } from '../src/policy.js'
import type { SourceInstance, SourceKind } from '../src/sources/kind.js'
import { SourceRegistry } from '../src/sources/registry.js'

let directory: string
let store: Store
let clock: number
let paused: boolean
let effects: Effects
let sources: SourceRegistry
let outbox: Outbox
let sent: OutboundMessage[]
/** Whether the probe Source's channel accepts replies. */
let open: boolean
/** A Source whose channel records what it is asked to send. */
const probe: SourceKind<Record<string, never>> = {
  kind: 'probe',
  title: { zh: '探针', en: 'Probe' },
  description: { zh: '', en: '' },
  health: [],
  schema: z.object({}).strict(),
  fields: [],
  channel: {
    allowed: () => open,
    send: async (_host, message) => {
      sent.push(message)
      return 'sent'
    },
    link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }),
  },
}
const message = (id: string, source = 'probe'): OutboundMessage => ({
  id,
  channel: { source, thread: `${source}:1`, address: {} },
  text: 'Done',
  kind: 'reply',
})

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'outbox-'))
  store = new Store(join(directory, 'db.sqlite'))
  clock = Date.parse('2026-09-09T00:00:00Z')
  paused = false
  sent = []
  open = true
  const board = new HealthBoard()
  effects = new Effects(store, board, () => clock)
  effects.start()
  const settings = SettingsSchema.parse({ sources: { probe: { enabled: true, config: {} } } })
  sources = new SourceRegistry(() => settings, board)
  outbox = new Outbox({ store, effects, sources, commands: {} as Commands, paused: () => paused })
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

it('holds every message while processing is paused, and sends it once processing resumes', async () => {
  sources.register(probe)
  paused = true
  outbox.send(message('held'))
  await outbox.sent()
  expect([outbox.status('held'), sent.length]).toEqual(['pending', 0])
  paused = false
  // The paused handler asked for no slot; a new pass starts it.
  clock += 5000
  effects.kick()
  await outbox.sent()
  expect([outbox.status('held'), sent.map((item) => item.id)]).toEqual(['sent', ['held']])
})

it("keeps a message for a Source that is not installed waiting, and sends it once the Source's kind registers", async () => {
  outbox.send(message('waiting'))
  await outbox.sent()
  expect([outbox.status('waiting'), sent.length]).toEqual(['pending', 0])
  sources.register(probe)
  // A message whose Source was not installed is tried again after 5 seconds.
  clock += 5000
  effects.kick()
  await outbox.sent()
  expect([outbox.status('waiting'), sent.map((item) => item.id)]).toEqual(['sent', ['waiting']])
})

it('settles a message as dropped when its channel is not allowed, and sends nothing', async () => {
  sources.register(probe)
  open = false
  outbox.send(message('ignored'))
  await outbox.sent()
  expect(sent).toEqual([])
  expect(outbox.status('ignored')).toBe('dropped')
  open = true
  outbox.send(message('allowed'))
  await outbox.sent()
  expect([outbox.status('allowed'), sent.map((item) => item.id)]).toEqual(['sent', ['allowed']])
})

it('keeps a message waiting when its Source stops being installed between the check and the send', async () => {
  const raced = new Effects(store, new HealthBoard(), () => clock)
  raced.start()
  const waiting = new Outbox({
    store,
    effects: raced,
    sources: {
      instance: <C extends Record<string, unknown>>() =>
        ({ id: 'probe', kind: 'probe', enabled: true, config: {} }) as unknown as SourceInstance<C>,
      channelAllowed: () => true,
      send: async () => 'waiting',
    },
    commands: {} as Commands,
    paused: () => false,
  })
  waiting.send(message('raced'))
  await waiting.sent()
  expect(waiting.status('raced')).toBe('pending')
})
