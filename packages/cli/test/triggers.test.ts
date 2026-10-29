import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@agnes/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { triggersCommand } from '../src/commands/triggers.js'
import { FakeEndpoint } from './fake-endpoint.js'

const clients: Array<Awaited<ReturnType<typeof createClient>>> = []
const dirs: string[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const rule = {
  id: 'issues',
  enabled: true,
  provider: 'github',
  auth: 'hmac',
  secretRef: 'secret://hooks/github',
  event: 'issues\u001b[31m',
  filters: { '$.action': 'opened' },
  workspace: '/work',
  agent: 'workspace-write',
  bundles: [],
  template: 'Review {{$.issue.title}}',
  timestampPath: '$.issue.updated_at',
  windowSeconds: 300,
  ratePerMinute: 10,
}
const config = { enabled: true, path: '/hooks/agnes', maxPayloadBytes: 65536 }
const snapshot = (rules: unknown[] = [rule]) => ({
  snapshot: { config, rules, deliveries: [], secretRefs: [] },
})

function file(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'agh-triggers-'))
  dirs.push(dir)
  const path = join(dir, 'in.json')
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
  return path
}

async function run(argv: string[], reply: (params: Record<string, unknown>) => unknown) {
  const endpoint = new FakeEndpoint()
  endpoint
    .on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
    .on('_agnes/v1/admin.triggers', (params) => reply(params as Record<string, unknown>))
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  clients.push(client)
  let out = ''
  let err = ''
  const exit = await triggersCommand(parseArgs(argv), client, {
    stdout: { write: (t: string) => (out += t) } as never,
    stderr: { write: (t: string) => (err += t) } as never,
  }).catch((e: Error) => e)
  return {
    exit,
    out,
    err,
    calls: endpoint.calls.filter((c) => c.method === '_agnes/v1/admin.triggers').map((c) => c.params),
  }
}

describe('triggers command', () => {
  it('list prints the configuration and one inert line per rule; --json prints the daemon result', async () => {
    const r = await run(['triggers'], () => snapshot())
    expect(r.calls).toEqual([{ action: 'list' }])
    expect(r.out).toBe(
      'webhook enabled\t/hooks/agnes\tmax 65536 bytes\nissues\tenabled\tgithub/hmac\tissues[31m\t/work\n',
    )
    expect((await run(['triggers', 'list', '--json'], () => snapshot())).out).toBe(
      `${JSON.stringify(snapshot())}\n`,
    )
    expect((await run(['triggers'], () => snapshot([]))).out).toContain('no trigger rules')
  })

  it('add upserts a valid rule and refuses one that exists; edit needs the same id and an existing rule', async () => {
    const add = await run(['triggers', 'add', '--file', file(rule)], (p) =>
      p.action === 'list' ? snapshot([]) : snapshot(),
    )
    expect(add.calls).toEqual([{ action: 'list' }, { action: 'upsert', rule }])
    expect(add.out).toBe('saved issues\n')
    const dup = await run(['triggers', 'add', '--file', file(rule)], () => snapshot())
    expect(dup.exit).toBe(1)
    expect(dup.err).toBe('refused: rule_exists issues\n')
    expect(dup.calls).toEqual([{ action: 'list' }])
    const edit = await run(['triggers', 'edit', 'issues', '--file', file({ ...rule, enabled: false })], () =>
      snapshot(),
    )
    expect(edit.calls[1]).toEqual({ action: 'upsert', rule: { ...rule, enabled: false } })
    const other = await run(['triggers', 'edit', 'other', '--file', file(rule)], () => snapshot())
    expect(other.exit).toMatchObject({ name: 'UsageError' })
    expect(other.calls).toEqual([])
    const missing = await run(['triggers', 'edit', 'issues', '--file', file(rule)], () => snapshot([]))
    expect(missing.exit).toBe(1)
    expect(missing.err).toBe('refused: no_such_rule issues\n')
  })

  it('remove, test and configure send the matching admin.triggers action', async () => {
    const del = await run(['triggers', 'remove', 'issues'], () => snapshot([]))
    expect(del.calls).toEqual([{ action: 'delete', ruleId: 'issues' }])
    expect(del.out).toBe('removed issues\n')
    const ok = await run(['triggers', 'test', 'issues', '--payload', file({ action: 'opened' })], () => ({
      delivery: { id: 'd1', at: 1, status: 'accepted', ruleId: 'issues' },
    }))
    expect(ok.calls).toEqual([{ action: 'test', ruleId: 'issues', payload: { action: 'opened' } }])
    expect(ok.exit).toBe(0)
    expect(ok.out).toBe('accepted\n')
    const bad = await run(['triggers', 'test', 'issues'], () => ({
      delivery: { id: 'd1', at: 1, status: 'no-rule', reason: 'r\u001b[0m' },
    }))
    expect(bad.calls[0]).toEqual({ action: 'test', ruleId: 'issues', payload: {} })
    expect(bad.exit).toBe(1)
    expect(bad.err).toBe('refused: no-rule\n')
    const cfg = await run(['triggers', 'configure', '--file', file(config)], () => snapshot())
    expect(cfg.calls).toEqual([{ action: 'configure', config }])
  })

  it('invalid JSON or a schema mismatch is refused locally and sends nothing', async () => {
    for (const argv of [
      ['triggers', 'add', '--file', file('{nope')],
      ['triggers', 'add', '--file', file({ ...rule, id: 'Bad Id' })],
      ['triggers', 'add', '--file', file({ ...rule, extra: 1 })],
      ['triggers', 'add', '--file', file({ id: 'x' })],
      ['triggers', 'add'],
      ['triggers', 'add', '--file', '/nonexistent/rule.json'],
      ['triggers', 'configure', '--file', file({ ...config, path: '/nope' })],
      ['triggers', 'test', 'issues', '--payload', file('not json')],
      ['triggers', 'remove'],
      ['triggers', 'deliver'],
    ]) {
      const r = await run(argv, () => snapshot())
      expect(r.exit, argv.join(' ')).toMatchObject({ name: 'UsageError' })
      expect(r.calls).toEqual([])
    }
  })

  it('shows a daemon error as it comes', async () => {
    const r = await run(['triggers', 'remove', 'issues'], () => {
      throw new Error('admin required')
    })
    expect((r.exit as Error).message).toContain('admin required')
  })
})
