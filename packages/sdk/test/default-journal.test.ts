import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClient as browserClient } from '../src/index.browser.js'
import { createClient } from '../src/index.node.js'
import { memoryJournal } from '../src/journal.js'

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => {
    if (!home.path) throw new Error('test home not initialized')
    return home.path
  },
}))
const clients: Array<{ close(): Promise<void> }> = []
beforeEach(() => {
  home.path = mkdtempSync(join(tmpdir(), 'agnes-default-journal-'))
})
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  rmSync(home.path, { recursive: true, force: true })
  vi.unstubAllGlobals()
})
const stdio = () => ({
  kind: 'stdio' as const,
  cmd: [process.execPath, fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url))],
})
it('uses the actual default file journal through a real stdio handshake', async () => {
  const client = createClient({ transport: stdio() })
  clients.push(client)
  await client.initialize()
  const id = await client.clientId()
  expect(id).toMatch(/^[a-f0-9]{32}$/)
  const file = join(home.path, '.agh', 'sdk', id, 'journal.json')
  expect(JSON.parse(readFileSync(file, 'utf8')).clientId).toBe(id)
  expect(await client.journal.nextCommandId('s')).toBe(`${id}:s:1`)
  const resumed = createClient({ transport: stdio(), clientId: id })
  clients.push(resumed)
  expect(await resumed.journal.nextCommandId('s')).toBe(`${id}:s:2`)
})
it.each(['../escape', '..', '中'.repeat(128)])(
  'keeps identity %s inside one owned path segment',
  async (id) => {
    const client = createClient({ transport: stdio(), clientId: id })
    clients.push(client)
    expect(await client.clientId()).toBe(id)
    const dir = join(home.path, '.agh', 'sdk')
    const children = readdirSync(dir)
    expect(children).toHaveLength(1)
    const child = children[0]
    if (!child) throw new Error('missing journal directory')
    expect(JSON.parse(readFileSync(join(dir, child, 'journal.json'), 'utf8')).clientId).toBe(id)
    expect(readdirSync(home.path)).toEqual(['.agh'])
  },
)
it('keeps inproc in memory and preserves explicit journal precedence', async () => {
  const endpoint = {
    async handle() {},
    notifications: (async function* () {})(),
    async close() {},
  }
  const inproc = createClient({ transport: { kind: 'inproc', endpoint }, clientId: 'local' })
  const supplied = memoryJournal('authoritative')
  const explicit = createClient({ transport: stdio(), clientId: 'ignored', journal: supplied })
  clients.push(inproc, explicit)
  expect(await inproc.clientId()).toBe('local')
  expect(await explicit.clientId()).toBe('authoritative')
  expect(explicit.journal).toBe(supplied)
  expect(readdirSync(home.path)).toEqual([])
})
it('uses browser default storage and separates explicit identities without replacing an injected journal', async () => {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  })
  const transport = { kind: 'ws' as const, url: 'ws://127.0.0.1:1/' }
  const a = browserClient({ transport })
  const b = browserClient({ transport })
  const named = browserClient({ transport, clientId: 'chosen' })
  const injected = memoryJournal('injected')
  const explicit = browserClient({ transport, clientId: 'ignored', journal: injected })
  clients.push(a, b, named, explicit)
  expect(await b.clientId()).toBe(await a.clientId())
  expect(await named.clientId()).toBe('chosen')
  expect(await explicit.clientId()).toBe('injected')
  expect([...data.keys()].sort()).toEqual(['agnes-sdk-journal', 'agnes-sdk-journal:chosen'])
})
