// Enter while this client's own prompt runs queues the input in the daemon, and the daemon runs it by
// itself once that turn ends: real SDK + local daemon endpoint + core. Observation is the durable
// ledger projection, not RPC records, so a client that merely sent the input would not pass.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalEndpoint } from '@agnes/daemon/local'
import { createTestHost } from '@agnes/host/testkit'
import { createClient } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { TuiApp } from '../../src/tui/app.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { slowProvider } from '../boot-host.js'

it("runs a follow-up typed during this client's prompt after that turn ends, once and in order", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-tui-busy-queue-'))
  let inferences = 0
  const { host } = await createTestHost({
    dataDir: dir,
    provider: slowProvider(400, () => {
      inferences++
    }),
  })
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    await client.workspace.add(dir)
    const session = await client.session.new({ cwd: dir })
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    term.feed('first')
    term.feed('\r')
    await vi.waitFor(() => expect(inferences).toBe(1))
    expect(app.busy).toBe(true)
    term.feed('second')
    term.feed('\r')
    // Queued behind the running turn: the daemon holds it, no second inference has started.
    expect(inferences).toBe(1)
    await vi.waitFor(() => expect(inferences).toBe(2), { timeout: 8_000 })
    await vi.waitFor(() => expect(app?.busy).toBe(false), { timeout: 8_000 })
    const users = (await session.projectUI()).nodes
      .filter((node) => node.kind === 'user')
      .flatMap((node) => (node.kind === 'user' ? node.content : []))
      .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    expect(users).toEqual(['first', 'second'])
    expect(inferences).toBe(2)
    expect((await session.controls()).pending).toEqual([])
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)
