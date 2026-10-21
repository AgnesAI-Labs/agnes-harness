import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@agnes/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { settingsCommand } from '../src/commands/settings.js'
import { FakeEndpoint } from './fake-endpoint.js'

const clients: Array<Awaited<ReturnType<typeof createClient>>> = []
const dirs: string[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function file(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'agh-settings-'))
  dirs.push(dir)
  const path = join(dir, 'in.json')
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
  return path
}

const engine = { enabled: false, command: '', args: [], allow: [] }
const engines = {
  codex: engine,
  claudeCode: engine,
  sdk: { enabled: false, protocol: 'sdk', command: '', args: [], allow: [] },
}
const memory = {
  workspaces: [{ path: '/work', available: true }],
  inspection: {
    root: '/work/.agnes/memory',
    settings: {
      mode: 'ask',
      indexMaxBytes: 1,
      indexMaxLines: 1,
      topicMaxBytes: 1,
      totalMaxBytes: 1,
      tokenBudget: 128,
      userTokenBudget: 128,
      userEnabled: false,
    },
    files: [],
    bytes: 0,
  },
}
const health = { status: 'idle', queued: 0, dropped: 0, failures: 0 }
const prompt = (config: Record<string, unknown>) => ({
  config,
  effect: 'new-sessions',
  sections: [],
  hash: 'a'.repeat(64),
  revision: 'b'.repeat(64),
  preview: 'default-sections',
})

/** section: what a `get` returns, and a valid document for `set` with the RPC it must reach. */
const CASES = [
  {
    section: 'model-slots',
    read: '_agnes/v1/config.modelSlots.get',
    write: '_agnes/v1/config.modelSlots.save',
    result: { revision: 3, slots: {} },
    doc: { revision: 3, slots: { fast: null } },
    line: 'revision: 3\n',
  },
  {
    section: 'child-engines',
    read: '_agnes/v1/config.childEngines.get',
    write: '_agnes/v1/config.childEngines.save',
    result: { revision: 1, engines, effect: 'new-sessions' },
    // a `get --json` document carries `effect`, which the save schema refuses: it is dropped
    doc: { revision: 1, engines, effect: 'new-sessions' },
    sent: { revision: 1, engines },
    line: 'effect: new-sessions\n',
  },
  {
    section: 'auto-review',
    read: '_agnes/v1/autoReview.get',
    write: '_agnes/v1/autoReview.save',
    result: { enabled: true, maxRisk: 'low' },
    doc: { enabled: false },
    line: 'enabled: true\nmaxRisk: low\n',
  },
  {
    section: 'system-prompt',
    read: '_agnes/v1/systemPrompt.get',
    write: '_agnes/v1/systemPrompt.save',
    result: prompt({ personaSuffix: 'be brief\u001b[31m' }),
    doc: { config: { personaSuffix: 'x' } },
    line: 'config.personaSuffix: be brief[31m\n',
    readParams: {},
  },
  {
    section: 'memory',
    read: '_agnes/v1/admin.memory',
    write: '_agnes/v1/admin.memory',
    result: memory,
    doc: { settings: { mode: 'auto' } },
    sent: { cwd: process.cwd(), settings: { mode: 'auto' } },
    readParams: { cwd: process.cwd() },
    line: 'workspaces[0].path: /work\n',
  },
  {
    section: 'observability',
    read: '_agnes/v1/admin.observability',
    write: '_agnes/v1/admin.observability',
    result: { settings: { enabled: false }, health },
    doc: { settings: { enabled: true, endpoint: 'http://localhost:4318' } },
    line: 'settings.enabled: false\n',
  },
  {
    section: 'search',
    read: '_agnes/v1/admin.search.get',
    write: '_agnes/v1/admin.search.save',
    result: { version: 1, defaultProvider: 'brave', providers: [] },
    doc: { provider: { id: 'brave', enabled: true }, defaultProvider: 'brave' },
    line: 'version: 1\ndefaultProvider: brave\nproviders: []\n',
  },
  {
    section: 'session-defaults',
    read: '_agnes/v1/sessionSelection.defaults.get',
    write: '_agnes/v1/sessionSelection.defaults.save',
    result: { revision: 2, defaults: { permission: 'read-only' } },
    doc: { revision: 2, defaults: { permission: 'workspace-write' } },
    line: 'revision: 2\ndefaults.permission: read-only\n',
  },
] as const

async function run(argv: string[], handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
  const endpoint = new FakeEndpoint().on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
  for (const [method, h] of Object.entries(handlers))
    endpoint.on(method, (params) => h(params as Record<string, unknown>))
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  clients.push(client)
  let out = ''
  let err = ''
  const exit = await settingsCommand(parseArgs(['settings', ...argv]), client, {
    stdout: { write: (t: string) => (out += t) } as never,
    stderr: { write: (t: string) => (err += t) } as never,
  }).catch((e: Error) => e)
  return {
    exit,
    out,
    err,
    calls: endpoint.calls.filter((c) => c.method.startsWith('_agnes/v1/')).map((c) => [c.method, c.params]),
  }
}

describe('settings command', () => {
  it('lists every section with a description when given no section', async () => {
    const r = await run([], {})
    expect(r.exit).toBe(0)
    expect(r.calls).toEqual([])
    expect(
      r.out
        .trim()
        .split('\n')
        .map((l) => l.split(/\s+/, 1)[0]),
    ).toEqual(CASES.map((c) => c.section))
  })

  for (const c of CASES) {
    it(`${c.section}: get sends ${c.read}, prints lines or the raw result; set sends ${c.write}`, async () => {
      const handlers = { [c.read]: () => c.result, [c.write]: () => c.result }
      const got = await run([c.section, 'get'], handlers)
      expect(got.calls).toEqual([[c.read, 'readParams' in c ? c.readParams : {}]])
      expect(got.out).toContain(c.line)
      const bare = await run([c.section], handlers)
      expect(bare.out).toBe(got.out)
      expect((await run([c.section, 'get', '--json'], handlers)).out).toBe(`${JSON.stringify(c.result)}\n`)

      const set = await run([c.section, 'set', '--file', file(c.doc)], handlers)
      expect(set.exit).toBe(0)
      expect(set.out).toBe(`saved ${c.section}\n`)
      expect(set.calls).toEqual([[c.write, 'sent' in c ? c.sent : c.doc]])
      expect((await run([c.section, 'set', '--file', file(c.doc), '--json'], handlers)).out).toBe(
        `${JSON.stringify(c.result)}\n`,
      )
    })
  }

  it('invalid JSON, a schema-invalid document or a missing file sends no request', async () => {
    const handlers = { '_agnes/v1/autoReview.save': () => ({}), '_agnes/v1/admin.memory': () => memory }
    for (const argv of [
      ['auto-review', 'set', '--file', file('{nope')],
      ['auto-review', 'set', '--file', file({ enabled: 'yes' })],
      ['auto-review', 'set', '--file', file([])],
      ['auto-review', 'set', '--file', '/nonexistent/in.json'],
      ['auto-review', 'set'],
      ['auto-review', 'set', '--text', 'x'],
      ['system-prompt', 'set', '--text', 'x'],
      ['memory', 'set', '--file', file({ cwd: '/work' })],
      ['nope'],
      ['search', 'frob'],
      ['auto-review', 'test'],
    ]) {
      const r = await run(argv, handlers)
      expect(r.exit, argv.join(' ')).toBeInstanceOf(Error)
      expect((r.exit as Error).constructor.name).toBe('UsageError')
      expect(r.calls).toEqual([])
    }
  })

  it('system-prompt set --text replaces the prompt on top of the stored config with its revision', async () => {
    const stored = prompt({ personaSuffix: 'keep', fullOverride: 'old' })
    const r = await run(['system-prompt', 'set', '--text', 'Be terse.', '--yes'], {
      '_agnes/v1/systemPrompt.get': () => stored,
      '_agnes/v1/systemPrompt.save': () => prompt({ fullOverride: 'Be terse.' }),
    })
    expect(r.exit).toBe(0)
    expect(r.calls[1]).toEqual([
      '_agnes/v1/systemPrompt.save',
      {
        config: { personaSuffix: 'keep', fullOverride: 'Be terse.' },
        confirmFullOverride: true,
        expectedRevision: 'b'.repeat(64),
      },
    ])
    const clear = await run(['system-prompt', 'set', '--text', ''], {
      '_agnes/v1/systemPrompt.get': () => stored,
      '_agnes/v1/systemPrompt.save': () => prompt({}),
    })
    expect(clear.calls[1]?.[1]).toMatchObject({
      config: { personaSuffix: 'keep' },
      confirmFullOverride: false,
    })
    expect(clear.calls[1]?.[1]).not.toHaveProperty('config.fullOverride')
  })

  it('search test runs one query on the given or default provider; only search has test', async () => {
    const handlers = {
      '_agnes/v1/admin.search.get': () => ({ defaultProvider: 'brave' }),
      '_agnes/v1/admin.search.test': () => ({ ok: true, results: [{ title: 'T\u001b[1m', url: 'u' }] }),
    }
    const dflt = await run(['search', 'test', '--text', 'agnes'], handlers)
    expect(dflt.calls[1]).toEqual(['_agnes/v1/admin.search.test', { provider: 'brave', query: 'agnes' }])
    expect(dflt.out).toContain('results[0].title: T[1m\n')
    const named = await run(['search', 'test', 'tavily', '--text', 'agnes'], handlers)
    expect(named.calls).toEqual([['_agnes/v1/admin.search.test', { provider: 'tavily', query: 'agnes' }]])
    const bad = await run(['search', 'test'], handlers)
    expect((bad.exit as Error).constructor.name).toBe('UsageError')
    const failed = await run(['search', 'test', 'tavily', '--text', 'q'], {
      '_agnes/v1/admin.search.test': () => ({ ok: false, message: 'bad key\nline' }),
    })
    expect(failed.exit).toBe(1)
    expect(failed.err).toBe('refused: bad key line\n')
  })

  it('a daemon refusal propagates verbatim', async () => {
    const r = await run(['auto-review', 'get'], {
      '_agnes/v1/autoReview.get': () => {
        throw Object.assign(new Error('admin only'), { code: -32000 })
      },
    })
    expect(r.exit).toBeInstanceOf(Error)
    expect((r.exit as Error).message).toContain('admin only')
  })
})
