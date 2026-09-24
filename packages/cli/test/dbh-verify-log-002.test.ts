import { createClient } from '@agnes/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { sessionsCommand } from '../src/commands/sessions.js'
import { FakeEndpoint } from './fake-endpoint.js'

// DBH LOG-002 verification. `sessionsCommand` (packages/cli/src/commands/sessions.ts:35) asks for
// `limit: 1` on `show`, then filters the returned page to the exact id (:40). `q.text` is a
// SUBSTRING hint, not an equality predicate -- both daemon listers agree on that, independently of
// the CLI:
//   - packages/daemon/src/storage/lister.ts:58,60,71  -> `.filter(key => !q.q || key.includes(q.q))`
//     then `.sort()` then `rows.slice(0, limit)`
//   - packages/daemon/src/local/sessions.ts:253-269   -> `.filter(k => !q.q || k.includes(q.q))`
//     then `items.slice(offset, offset + limit)`
//   - packages/daemon/src/local/methods/agnes.ts:883  -> `const q = p.q?.text ?? p.q?.prefix`
// The endpoint below is a faithful stub of exactly that semantic (substring + ascending sort +
// slice-to-limit). Session keys are caller-chosen with no `agnes:` enforcement
// (packages/protocol/schema/agnes-v1.json:124-127 -- `type: string, maxLength: 512`, no pattern;
// packages/cli/src/commands/import.ts:76 passes `--key` through verbatim), so a key that contains
// another key as a substring and sorts ahead of it is reachable.
const KEYS = ['aagnes:x', 'agnes:x']

function listerEndpoint(): FakeEndpoint {
  const endpoint = new FakeEndpoint()
  endpoint
    .on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
    .on('_agnes/v1/session.list', (received) => {
      const p = received as { limit?: number; q?: { text?: string; prefix?: string } }
      const needle = p.q?.text ?? p.q?.prefix
      const matched = KEYS.filter((key) => !needle || key.includes(needle))
        .sort()
        .slice(0, p.limit ?? 50)
      return {
        items: matched.map((sessionId) => ({
          sessionId,
          createdAt: '2026-09-12T00:00:00Z',
          lastSeq: 4,
          generation: 1,
          preset: 'standard',
        })),
      }
    })
  return endpoint
}

const clients: Array<Awaited<ReturnType<typeof createClient>>> = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
})

describe('DBH LOG-002: sessions show must find a session whose key is a substring of another', () => {
  it('[control] finds the session when no other key contains it', async () => {
    const client = createClient({ transport: { kind: 'inproc', endpoint: listerEndpoint() } })
    clients.push(client)
    const writes: string[] = []
    const exit = await sessionsCommand(parseArgs(['sessions', 'show', 'aagnes:x']), client, {
      stdout: { write: (text: string) => writes.push(text) } as never,
      stderr: { write: () => true } as never,
    })
    expect(exit).toBe(0)
    expect(writes.join('')).toContain('aagnes:x')
  })

  it('finds agnes:x even though aagnes:x also matches the substring hint and sorts first', async () => {
    const client = createClient({ transport: { kind: 'inproc', endpoint: listerEndpoint() } })
    clients.push(client)
    const writes: string[] = []
    const exit = await sessionsCommand(parseArgs(['sessions', 'show', 'agnes:x']), client, {
      stdout: { write: (text: string) => writes.push(text) } as never,
      stderr: { write: () => true } as never,
    })
    expect(exit).toBe(0)
    // `toContain('agnes:x')` would also be satisfied by a printed `aagnes:x`, so assert the exact id row.
    expect(writes.join('').split('\n')[0]).toBe('id       agnes:x')
    expect(writes.join('')).not.toContain('aagnes:x')
  })
})
