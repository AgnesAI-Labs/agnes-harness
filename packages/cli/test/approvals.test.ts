import { createClient } from '@agnes/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { approvalsCommand } from '../src/commands/approvals.js'
import { FakeEndpoint } from './fake-endpoint.js'

const clients: Array<Awaited<ReturnType<typeof createClient>>> = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
})

const grant = {
  grantId: 'g1',
  lifetime: 'session',
  toolId: 'shell\u001b[31m',
  scope: 'run `ls`\nrm -rf /',
  createdAt: '2026-10-22T00:00:00Z',
}

async function run(argv: string[], method: string, reply: unknown | Error) {
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
  const exit = await approvalsCommand(parseArgs(argv), client, {
    stdout: { write: (text: string) => (out += text) } as never,
    stderr: { write: () => true } as never,
  }).catch((e: Error) => e)
  return { exit, out, params: endpoint.calls.find((c) => c.method === method)?.params }
}

describe('approvals command', () => {
  it('grants lists one inert line per grant for the session, and --json prints the daemon result', async () => {
    const reply = { grants: [grant, { ...grant, grantId: 'g2', lifetime: 'always', scope: 's' }] }
    const r = await run(['approvals', 'grants', 's1'], '_agnes/v1/approvalGrants.forSession', reply)
    expect(r.params).toEqual({ sessionId: 's1' })
    expect(r.exit).toBe(0)
    expect(r.out).toBe(
      [
        'g1\tshell[31m\tsession\t2026-10-22T00:00:00Z\trun `ls` rm -rf /',
        'g2\tshell[31m\talways\t2026-10-22T00:00:00Z\ts',
        '',
      ].join('\n'),
    )
    expect(
      (await run(['approvals', 'grants', 's1', '--json'], '_agnes/v1/approvalGrants.forSession', reply)).out,
    ).toBe(`${JSON.stringify(reply)}\n`)
    expect(
      (await run(['approvals', 'grants', 's1'], '_agnes/v1/approvalGrants.forSession', { grants: [] })).out,
    ).toBe('no approval grants\n')
  })

  it('revoke sends session and grant ids and echoes the stored record', async () => {
    const stored = { ...grant, revokedAt: '2026-10-22T01:00:00Z' }
    const r = await run(
      ['approvals', 'revoke', 's1', 'g1'],
      '_agnes/v1/approvalGrants.revokeForSession',
      stored,
    )
    expect(r.params).toEqual({ sessionId: 's1', grantId: 'g1' })
    expect(r.out).toBe('revoked g1\tshell[31m\tsession\t2026-10-22T00:00:00Z\trun `ls` rm -rf /\trevoked\n')
  })

  it('shows a daemon refusal as it comes and rejects missing arguments before any call', async () => {
    const refused = await run(
      ['approvals', 'revoke', 's1', 'nope'],
      '_agnes/v1/approvalGrants.revokeForSession',
      new Error('unknown grant'),
    )
    expect(refused.exit).toBeInstanceOf(Error)
    expect((refused.exit as Error).message).toContain('unknown grant')
    for (const argv of [
      ['approvals'],
      ['approvals', 'grants'],
      ['approvals', 'revoke', 's1'],
      ['approvals', 'x'],
    ]) {
      const r = await run(argv, '_agnes/v1/approvalGrants.forSession', { grants: [] })
      expect(r.exit).toMatchObject({ name: 'UsageError' })
      expect(r.params).toBeUndefined()
    }
  })
})
