import { join } from 'node:path'
import type { EventEnvelope } from '@agnes/protocol'
import { createClient, memoryJournal } from '@agnes/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { openTestHost, say } from '../../daemon-rpc/test/host.js'
import { bindConnection } from '../src/supervisor/connection.js'
import { listenUnix } from '../src/supervisor/socket.js'
import { localSdkTransport, localSocketPath } from './local-socket-path.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

// Each turn writes about 18 rows, so this ledger is several times the 1000-frame subscription
// budget. Replaying it to a fresh client used to end the connection with OVERLOADED on every
// attempt, which `agh export` of a long session reported as DAEMON_CONNECTION_CLOSED.
const TURNS = 160

it('replays a ledger longer than the subscription budget in full to a fresh client over a real socket', async () => {
  const h = await openTestHost({
    script: Array.from({ length: TURNS }, (_, i) => say(`answer ${i} ${'x'.repeat(512)}`)),
  })
  const path = localSocketPath(join(h.dataDir, 'daemon', 'replay.sock'))
  const connections: Promise<void>[] = []
  let closes = 0
  const server = await listenUnix(path, (socket) => {
    connections.push(
      bindConnection(socket, h.endpoint({ pollMs: 5 }), {
        onClose() {
          closes++
        },
      }).closed,
    )
  })
  cleanup.push(async () => {
    await server.close()
    await Promise.all(connections)
    await h.close()
  })
  const writer = createClient({ journal: memoryJournal(), transport: localSdkTransport(path) })
  await writer.workspace.add(h.dataDir)
  const session = await writer.session.new({ cwd: h.dataDir })
  // What the writer saw live is the reference the replay must reproduce row for row.
  const live: EventEnvelope[] = []
  const stream = session.events()[Symbol.asyncIterator]()
  const following = (async () => {
    for (let next = await stream.next(); !next.done; next = await stream.next()) {
      const { _meta: _ignored, ...row } = next.value
      live.push(row)
    }
  })()
  for (let i = 0; i < TURNS; i++) await session.prompt(`question ${i}`)
  const id = session.id
  const lastSeq = session.lastSeq
  expect(lastSeq).toBeGreaterThan(2500)
  await vi.waitFor(() => expect(live.length).toBe(lastSeq))
  await stream.return?.()
  await following
  await writer.close()
  await Promise.all(connections)
  expect(closes).toBe(1)

  // The same sequence `agh export` uses: restore, verify integrity, then attach from seq 0 and read
  // through the attach response's watermark.
  const reader = createClient({ journal: memoryJournal(), transport: localSdkTransport(path) })
  cleanup.push(() => reader.close())
  await reader.workspace.add(h.dataDir)
  await reader.restoreSession(id, '')
  expect(await reader.session.integrity(id, true)).toMatchObject({ state: 'verified' })
  const attaching = reader.session.attach(id, { filter: { acpUpdates: false } })
  const handle = reader.sessions.get(id)
  if (!handle) throw new Error('sdk did not publish the session handle before attach')
  const replay = handle.events()[Symbol.asyncIterator]()
  const first = replay.next()
  await attaching
  expect(handle.lastServerSeq).toBe(lastSeq)
  const rows: EventEnvelope[] = []
  for (let next = await first; !next.done; next = await replay.next()) {
    const { _meta: _ignored, ...row } = next.value
    rows.push(row)
    if (row.seq >= lastSeq) break
  }
  await replay.return?.()
  // The live tail orders keys as appended and the replay as stored, so this compares values.
  expect(rows).toEqual(live)
  expect(handle.closed).toBe(false)
  // The reader's connection is still the open one: nothing was cut to get here.
  expect(closes).toBe(1)
}, 120_000)
