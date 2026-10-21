import { describe, expect, it } from 'vitest'
import { pluginConfigCommand } from '../src/commands/plugin-config.js'
import { file, type Replies, run } from './admin-harness.js'

const schema = {
  type: 'object',
  required: ['url'],
  properties: {
    url: { type: 'string' },
    password: { type: 'string' },
    key: { type: 'string', writeOnly: true },
    nested: { type: 'object', properties: { handle: { type: 'string', 'x-secret': true } } },
  },
}
const stored = {
  url: 'https://x\u001b[31m',
  password: 'hunter2',
  key: 'sk-LIVE',
  nested: { handle: 'abc123', note: 'ok' },
}
const snapshot = {
  revision: 'rev-1',
  entries: [{ rowId: 'main', schema, value: stored, reload: 'live' }],
  audit: [{ who: 'u', when: 't', rowId: 'main', revision: 'r0', before: { key: 'old-LIVE' }, after: stored }],
}
const secrets = ['hunter2', 'sk-LIVE', 'abc123', 'old-LIVE']
const base: Replies = {
  'plugins.config.get': () => snapshot,
  'plugins.config.validate': () => ({ issues: [] }),
}

describe('plugins config', () => {
  it('get shows validity and a schema summary and never prints a secret, in text or --json', async () => {
    const text = await run(pluginConfigCommand, ['plugins', 'config', 'get', 'demo'], base)
    expect(text.exit).toBe(0)
    expect(text.out).toContain('main\treload live\tvalid')
    expect(text.out).toContain('url*:string')
    expect(text.out).toContain('key:string (secret)')
    expect(text.out).toContain('[redacted]')
    expect(text.out).toContain('https://x\\u001b[31m')
    for (const secret of secrets) expect(text.out).not.toContain(secret)
    const json = await run(pluginConfigCommand, ['plugins', 'config', 'get', 'demo', '--json'], base)
    for (const secret of secrets) expect(json.out).not.toContain(secret)
    expect(JSON.parse(json.out).entries[0].value.nested).toEqual({ handle: '[redacted]', note: 'ok' })
    expect(text.calls[0]).toEqual(['plugins.config.get', { profile: 'local-dev', id: 'demo' }])
  })

  it('validate lists every issue and exits 1; a valid value exits 0; nothing is ever saved', async () => {
    const bad = await run(
      pluginConfigCommand,
      ['plugins', 'config', 'validate', 'demo', '--file', file({})],
      {
        ...base,
        'plugins.config.validate': () => ({ issues: [{ path: '/url', code: 'required' }] }),
      },
    )
    expect(bad.exit).toBe(1)
    expect(bad.out).toBe('/url\trequired\n')
    const good = await run(
      pluginConfigCommand,
      ['plugins', 'config', 'validate', 'demo', 'main', '--file', file({ url: 'u' })],
      base,
    )
    expect(good.exit).toBe(0)
    expect(good.out).toBe('valid\n')
    expect(good.calls.at(-1)).toEqual([
      'plugins.config.validate',
      { profile: 'local-dev', id: 'demo', rowId: 'main', value: { url: 'u' } },
    ])
    expect([...bad.calls, ...good.calls].some(([m]) => m === 'plugins.config.save')).toBe(false)
  })

  it('set validates first, saves with the read revision, and does not save an invalid value', async () => {
    const invalid = await run(pluginConfigCommand, ['plugins', 'config', 'set', 'demo', '--file', file({})], {
      ...base,
      'plugins.config.validate': () => ({ issues: [{ path: '/url', code: 'required' }] }),
      'plugins.config.save': () => ({}),
    })
    expect(invalid.exit).toBe(1)
    expect(invalid.out).toContain('not saved')
    expect(invalid.calls.map(([m]) => m)).not.toContain('plugins.config.save')
    const saved = await run(
      pluginConfigCommand,
      ['plugins', 'config', 'set', 'demo', '--file', file({ url: 'u' })],
      {
        ...base,
        'plugins.config.save': () => ({
          ok: true,
          revision: 'rev-2',
          reason: 'saved',
          issues: [],
          reload: 'live',
        }),
      },
    )
    expect(saved.exit).toBe(0)
    expect(saved.out).toBe('saved\tmain\treload live\n')
    expect(saved.calls.at(-1)?.[1]).toMatchObject({
      id: 'demo',
      rowId: 'main',
      value: { url: 'u' },
      expectedRevision: 'rev-1',
    })
    const refused = await run(
      pluginConfigCommand,
      ['plugins', 'config', 'set', 'demo', '--file', file({ url: 'u' })],
      {
        ...base,
        'plugins.config.save': () => ({
          ok: false,
          revision: 'rev-1',
          reason: 'refused',
          refusalReason: 'locked\nby admin',
          issues: [],
          reload: 'live',
        }),
      },
    )
    expect(refused.exit).toBe(1)
    expect(refused.out).toContain('not saved: refused locked by admin')
  })

  it('bad usage and invalid JSON send no request', async () => {
    for (const argv of [
      ['plugins', 'config'],
      ['plugins', 'config', 'get'],
      ['plugins', 'config', 'bogus', 'demo'],
      ['plugins', 'config', 'set', 'demo'],
      ['plugins', 'config', 'set', 'demo', '--file', file('{not json')],
    ]) {
      const r = await run(pluginConfigCommand, argv, base)
      expect(r.exit).toMatchObject({ name: 'UsageError' })
      expect(r.calls).toEqual([])
    }
    const two = {
      ...base,
      'plugins.config.get': () => ({
        ...snapshot,
        entries: [...snapshot.entries, { ...snapshot.entries[0], rowId: 'b' }],
      }),
    }
    const ambiguous = await run(
      pluginConfigCommand,
      ['plugins', 'config', 'validate', 'demo', '--file', file({})],
      two,
    )
    expect(ambiguous.exit).toMatchObject({ name: 'UsageError', message: expect.stringContaining('main, b') })
  })
})
