import type { NodeClient } from '@agnes/sdk'
import { createClient, memoryJournal } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  createResourceConfirmationQueue,
  createResourceController,
  runResourceTuiSlash,
} from '../../src/commands/resources.js'
import { TuiApp } from '../../src/tui/app.js'
import { runSlash } from '../../src/tui/commands.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { scriptedEndpoint } from '../fake-endpoint.js'

// Deep Bug Hunt M-12. Oracle: INV-17 -- a mutating TUI resource action is queued and only runs after
// `/<kind> confirm`; runSlash's own prompt text "Pending resource operation ... run /mcp confirm".
// The resource parser accepts flags anywhere, so `--expected-revision <rev> trust srv` is the same
// mutating command as `trust srv --expected-revision <rev>`. Tests assert the correct behaviour; a
// failure reproduces the defect.

const REV = 'a'.repeat(64)

async function appWith(resourceController: ConstructorParameters<typeof TuiApp>[0]['resourceController']) {
  const ep = scriptedEndpoint()
  const client = createClient({ transport: { kind: 'inproc', endpoint: ep }, journal: memoryJournal() })
  const session = await client.session.new({ cwd: '/w' })
  const app = new TuiApp({
    session,
    term: new FakeTerminal({ columns: 60, rows: 20 }),
    header: 'Agnes',
    profile: 'local-dev',
    ...(resourceController ? { resourceController } : {}),
  })
  return { app, client }
}

describe('dbh M-12: /mcp mutating action with a leading flag', () => {
  it('control: `/mcp trust srv --expected-revision` is queued, not executed', async () => {
    const execute = vi.fn(async () => ({ text: 'executed' }))
    const { app, client } = await appWith({ execute })
    try {
      const r = await runSlash(app, `/mcp trust srv --expected-revision ${REV}`)
      expect(r.text).toContain('Pending resource operation')
      expect(execute).not.toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it('`/mcp --expected-revision <rev> trust srv` is queued, not executed', async () => {
    const execute = vi.fn(async () => ({ text: 'executed' }))
    const { app, client } = await appWith({ execute })
    try {
      const r = await runSlash(app, `/mcp --expected-revision ${REV} trust srv`)
      expect({ text: r.text, executeCalls: execute.mock.calls }).toMatchObject({
        text: expect.stringContaining('Pending resource operation'),
        executeCalls: [],
      })
    } finally {
      await client.close()
    }
  })

  it('preserved: a read with a leading flag still runs at once', async () => {
    const execute = vi.fn(async () => ({ text: 'executed' }))
    const { app, client } = await appWith({ execute })
    try {
      const r = await runSlash(app, '/mcp --cursor c1 list')
      expect({ text: r.text, executeCalls: execute.mock.calls }).toEqual({
        text: 'executed',
        executeCalls: [['mcp', 'local-dev', ['--cursor', 'c1', 'list']]],
      })
    } finally {
      await client.close()
    }
  })

  it('preserved: a flag value that spells a mutating action is not the action', async () => {
    const execute = vi.fn(async () => ({ text: 'executed' }))
    const { app, client } = await appWith({ execute })
    try {
      const r = await runSlash(app, '/mcp --name trust list')
      expect({ text: r.text, executeCalls: execute.mock.calls.length }).toEqual({
        text: 'executed',
        executeCalls: 1,
      })
    } finally {
      await client.close()
    }
  })

  // The resource-control-cli package exports the same slash handling for other hosts.
  describe('runResourceTuiSlash (resource-control-cli copy)', () => {
    function port() {
      const execute = vi.fn(async () => ({ text: 'executed' }))
      const queue = createResourceConfirmationQueue()
      return {
        execute,
        app: {
          profile: 'local-dev',
          resourceController: { execute },
          queueResourceConfirmation: queue.queue,
          takeResourceConfirmation: queue.take,
          cancelResourceConfirmation: queue.cancel,
        },
      }
    }

    it('flag-first trust is queued, then runs as queued on confirm', async () => {
      const { app, execute } = port()
      const queued = await runResourceTuiSlash(app, '/mcp', ['--expected-revision', REV, 'trust', 'srv'])
      expect({ text: queued?.text, executeCalls: execute.mock.calls.length }).toMatchObject({
        text: expect.stringContaining('Pending resource operation'),
        executeCalls: 0,
      })
      await runResourceTuiSlash(app, '/mcp', ['confirm'])
      expect(execute.mock.calls).toEqual([['mcp', 'local-dev', ['--expected-revision', REV, 'trust', 'srv']]])
    })

    it('preserved: reads run at once, with or without a leading flag', async () => {
      const { app, execute } = port()
      await runResourceTuiSlash(app, '/mcp', ['--cursor', 'c1', 'list'])
      await runResourceTuiSlash(app, '/mcp', ['--name', 'trust', 'list'])
      expect(execute.mock.calls.length).toBe(2)
    })
  })

  describe('differential through the production resource controller (real parser, stub SDK boundary)', () => {
    function stubNodeClient() {
      const trustSet = vi.fn(async (_p: unknown) => ({ operationId: 'op-1', state: 'accepted' }))
      const client = {
        clientId: async () => 'cli-client',
        mcp: { servers: { trustSet } },
        resources: {
          operation: {
            get: async () => ({
              kind: 'mcp.trust',
              state: 'succeeded',
              target: 'srv',
              revision: REV,
            }),
          },
        },
      } as unknown as NodeClient
      return { client, trustSet }
    }

    it('control: normal order sends no trust RPC until /mcp confirm', async () => {
      const { client: nodeClient, trustSet } = stubNodeClient()
      const { app, client } = await appWith(createResourceController(nodeClient))
      try {
        await runSlash(app, `/mcp trust srv --expected-revision ${REV}`)
        expect(trustSet).not.toHaveBeenCalled()
        await runSlash(app, '/mcp confirm')
        expect(trustSet).toHaveBeenCalledTimes(1)
        expect(trustSet.mock.calls[0]?.[0]).toMatchObject({
          serverId: 'srv',
          trust: 'trusted',
          expectedRevision: REV,
        })
      } finally {
        await client.close()
      }
    })

    it('flag-first order sends no trust RPC before /mcp confirm', async () => {
      const { client: nodeClient, trustSet } = stubNodeClient()
      const { app, client } = await appWith(createResourceController(nodeClient))
      try {
        const r = await runSlash(app, `/mcp --expected-revision ${REV} trust srv`)
        expect({ text: r.text, trustSetCalls: trustSet.mock.calls }).toMatchObject({
          text: expect.stringContaining('Pending resource operation'),
          trustSetCalls: [],
        })
        // Preserved: confirm then sends exactly the queued operation.
        await runSlash(app, '/mcp confirm')
        expect(trustSet.mock.calls).toHaveLength(1)
        expect(trustSet.mock.calls[0]?.[0]).toMatchObject({
          serverId: 'srv',
          trust: 'trusted',
          expectedRevision: REV,
        })
      } finally {
        await client.close()
      }
    })
  })
})
