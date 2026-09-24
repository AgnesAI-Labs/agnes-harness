import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { operations } from '@agnes/code'
import { createTestHost } from '@agnes/host/testkit'
import type { Actor, InferenceEvent } from '@agnes/protocol'
import { createClient, memoryJournal } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createLocalEndpoint } from '../src/local/index.js'
import { TicketIndex } from '../src/storage/lister.js'
import { testWorkspaceCatalog } from './host.js'
import { sqliteTables } from './sqlite-tables.js'

const REQUESTER: Actor = { id: 'requester', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const APPROVER: Actor = { id: 'approver', org: 'local', role: 'admin', deptPath: [], attrs: {} }

const toolCall = (): InferenceEvent[] => [
  {
    type: 'toolcall_end',
    via: 'native',
    call: { toolUseId: '', name: 'shell', args: { command: 'echo restart-safe' }, ordinal: 0 },
  },
  { type: 'done', reason: 'toolUse' },
]

function parkedApproval(ticket: string) {
  let receipt: { requestId: string; bindingHash: string; expiresAt: string } | null = null
  return {
    async ask(request: { requestId: string; bindingHash: string }) {
      const expiresAt = new Date(Date.now() + 60_000).toISOString()
      receipt = { requestId: request.requestId, bindingHash: request.bindingHash, expiresAt }
      return { ticket, expiresAt }
    },
    async resume(got: string) {
      if (got !== ticket || !receipt) return null
      const found = receipt
      receipt = null
      return found
    },
  }
}

describe('approval ticket restart lookup', () => {
  it('indexes a real parked event and lets SDK decide it after the daemon endpoint restarts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-ticket-restart-'))
    const canonicalRoot = realpathSync(root)
    const indexFile = join(root, 'approval-index.sqlite')
    const ticket = '0123456789abcdef0123456789abcdef'
    const approval = parkedApproval(ticket)
    const { host } = await createTestHost({
      dataDir: root,
      packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
      packages: { '@agnes/code': { operations } },
      seams: {
        approval,
        principals: {
          resolve: async (_credential, surface) => (surface === 'approval' ? APPROVER : REQUESTER),
        },
      },
      script: [toolCall()],
    })
    const workspaces = await testWorkspaceCatalog(root)

    let firstClient: ReturnType<typeof createClient> | undefined
    let secondClient: ReturnType<typeof createClient> | undefined
    let firstTables: ReturnType<typeof sqliteTables> | undefined
    let secondTables: ReturnType<typeof sqliteTables> | undefined
    try {
      firstTables = sqliteTables(indexFile)
      const firstIndex = new TicketIndex(firstTables.table('approval_tickets'))
      const firstEndpoint = createLocalEndpoint(host, { pollMs: 5, tickets: firstIndex, workspaces })
      firstClient = createClient({
        transport: { kind: 'inproc', endpoint: firstEndpoint },
        journal: memoryJournal(),
      })
      await firstClient.initialize()
      const session = await firstClient.session.new({ cwd: root })
      await expect(session.prompt('run')).resolves.toMatchObject({ reason: 'parked' })
      await vi.waitFor(() => {
        expect(firstIndex.get(ticket)).toBe(session.id)
        expect(firstIndex.cwd(ticket)).toBe(canonicalRoot)
      })
      await firstClient.close()
      firstClient = undefined
      await firstTables.close()
      firstTables = undefined

      // New endpoint and new SQLite connection: neither the daemon registry nor the in-memory
      // client survived. The persisted index must locate and reopen the correct workspace itself.
      secondTables = sqliteTables(indexFile)
      const secondIndex = new TicketIndex(secondTables.table('approval_tickets'))
      const secondEndpoint = createLocalEndpoint(host, { pollMs: 5, tickets: secondIndex, workspaces })
      secondClient = createClient({
        transport: { kind: 'inproc', endpoint: secondEndpoint },
        journal: memoryJournal(),
      })
      await secondClient.initialize()
      await expect(secondClient.approval.decide(ticket, 'allowed-once', { kind: 'local' })).resolves.toEqual({
        seq: expect.any(Number),
      })

      const reopened = await secondClient.session.load(session.id, { cwd: root })
      const timeline = await reopened.projectUI(undefined, { surface: 'tui' })
      expect(timeline.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'approval',
            state: 'decided',
            decision: expect.objectContaining({ verdict: 'allowed-once', byLabel: APPROVER.id }),
          }),
        ]),
      )
    } finally {
      await secondClient?.close()
      await firstClient?.close()
      await secondTables?.close()
      await firstTables?.close()
      await host.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
