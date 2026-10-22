import { createClient } from '@agnes/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { sessionsCommand } from '../src/commands/sessions.js'
import { FakeEndpoint } from './fake-endpoint.js'

const clients: Array<ReturnType<typeof createClient>> = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
})

const preview = (extra: Record<string, unknown> = {}) => ({
  sessionId: 's1',
  turn: 3,
  busy: false,
  undoable: true,
  blockedBy: 'none',
  laterTurns: [],
  shellChanges: false,
  files: [{ path: 'a.txt', action: 'restore', undoable: true }],
  ...extra,
})

async function run(argv: string[], daemon: { preview?: () => unknown; undo?: () => unknown }) {
  const endpoint = new FakeEndpoint()
  endpoint
    .on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
    .on('session/load', () => ({}))
    .on('_agnes/v1/session.undo.preview', () => (daemon.preview ?? preview)())
    .on('_agnes/v1/session.undo', () =>
      (
        daemon.undo ??
        (() => ({ sessionId: 's1', turn: 3, seq: 8, restored: ['a.txt'], failed: [], conflicts: [] }))
      )(),
    )
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  clients.push(client)
  let out = ''
  const exit = await sessionsCommand(parseArgs(['sessions', 'undo', ...argv]), client, {
    stdout: { write: (text: string) => (out += text) } as never,
    stderr: { write: () => true } as never,
  }).catch((error: Error) => error)
  return { exit, out, calls: endpoint.calls.map((call) => call.method) }
}

describe('sessions undo', () => {
  it('prints only the preview without --yes and changes nothing', async () => {
    const r = await run(['s1'], {})
    expect(r.exit).toBe(0)
    expect(r.out).toContain('Turn 3 changed 1 file(s)')
    expect(r.out).toContain('Preview only')
    expect(r.calls).not.toContain('_agnes/v1/session.undo')
  })

  it('passes --turn and undoes with --yes, exiting 1 when a file was not restored', async () => {
    const ok = await run(['s1', '--turn', '3', '--yes'], {})
    expect(ok.exit).toBe(0)
    expect(ok.out).toContain('Undid the file changes of turn 3')
    expect(ok.calls).toContain('_agnes/v1/session.undo')
    const partial = await run(['s1', '--yes'], {
      undo: () => ({
        sessionId: 's1',
        turn: 3,
        seq: 8,
        restored: [],
        failed: [{ path: 'a.txt', reason: 'EIO' }],
        conflicts: [],
      }),
    })
    expect(partial.exit).toBe(1)
    expect(partial.out).toContain('not restored: a.txt (EIO)')
  })

  it('does not call undo for a turn the preview says cannot be undone', async () => {
    const r = await run(['s1', '--yes'], {
      preview: () => preview({ undoable: false, blockedBy: 'busy', busy: true }),
    })
    expect(r.exit).toBe(1)
    expect(r.out).toContain('A turn is running')
    expect(r.calls).not.toContain('_agnes/v1/session.undo')
  })

  it('rejects a bad --turn and a missing key', async () => {
    expect((await run(['s1', '--turn', '0'], {})).exit).toMatchObject({
      message: expect.stringContaining('--turn'),
    })
    expect((await run([], {})).exit).toMatchObject({ message: expect.stringContaining('expects <key>') })
  })
})
