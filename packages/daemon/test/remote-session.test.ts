import type { Host, HostSession } from '@agnes/host'
import { rpcError } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { encodeFrame } from '../src/supervisor/framing.js'
import { RemoteSession } from '../src/supervisor/remote-session.js'
import { handleCommand } from '../src/worker/commands.js'

it('propagates unrelated scan errors and refuses an indivisible oversized row', async () => {
  for (const code of ['SCAN_PAGE_TOO_LARGE', 'UNAUTHORIZED']) {
    const error = { code: -32603, message: 'refused', data: { code } }
    const remote = new RemoteSession(
      'error',
      'writer',
      1,
      {
        alive: true,
        async command() {
          throw error
        },
      } as never,
      '/test',
    )
    await expect(
      remote.scan({ fromSeq: 1, toSeq: code === 'UNAUTHORIZED' ? 500 : 1, limit: 500 }),
    ).rejects.toBe(error)
  }
})

it.each(['asc', 'desc'] as const)(
  'reads large history pages completely in %s order across worker frames',
  async (order) => {
    const rows = [1, 2, 3].map((seq) => ({ seq, data: 'A'.repeat(512) }))
    const hosted = {
      async scan(q: { fromSeq: number; toSeq: number; limit: number; order: string }) {
        const found = rows.filter((row) => row.seq >= q.fromSeq && row.seq <= q.toSeq)
        return (q.order === 'desc' ? found.reverse() : found).slice(0, q.limit)
      },
    } as unknown as HostSession
    const link = {
      alive: true,
      async command(method: string, params: Record<string, unknown>) {
        const result = await handleCommand(
          hosted,
          { kind: 'command', requestId: '1', method: method as 'scan', params },
          { host: {} as Host, aborts: new Map() },
        )
        // A small wire budget keeps this refusal path covered when the production ceiling grows.
        if (Buffer.byteLength(JSON.stringify(result)) > 1024)
          throw rpcError('INTERNAL_ERROR', { code: 'SCAN_PAGE_TOO_LARGE' })
        return JSON.parse(encodeFrame({ kind: 'reply', requestId: '1', result }).toString()).result
      },
    }
    const remote = new RemoteSession('large-history', 'writer', 1, link as never, '/test')
    const result = (await remote.scan({
      fromSeq: 1,
      toSeq: 3,
      limit: order === 'asc' ? 3 : 2,
      order,
    })) as typeof rows
    expect(result.map((row) => row.seq)).toEqual(order === 'asc' ? [1, 2, 3] : [3, 2])
    expect(result).toEqual(order === 'asc' ? rows : [...rows].reverse().slice(0, 2))
  },
)

describe('RemoteSession switch result bridge', () => {
  it('unwraps worker command envelopes to the HostSession sequence contract', async () => {
    const calls: unknown[] = []
    const link = {
      alive: true,
      async command(method: string, params: unknown) {
        calls.push([method, params])
        return { effectiveFromSeq: method === 'setPreset' ? 7 : method === 'setModel' ? 9 : 11 }
      },
    }
    const session = new RemoteSession('s', 'run', 1, link as never, '/workspace')
    const operator = { id: 'owner', org: 'local', role: 'owner', deptPath: [], attrs: {} }
    expect(await session.setPreset('standard')).toBe(7)
    expect(session.lastSeq).toBe(7)
    expect(await session.setModel({ slot: 'primary', route: 'faux', model: 'faux-1' })).toBe(9)
    expect(session.lastSeq).toBe(9)
    expect(await session.setYolo(true, operator)).toBe(11)
    expect(session.lastSeq).toBe(11)
    expect(calls).toEqual([
      ['setPreset', { preset: 'standard' }],
      ['setModel', { sel: { slot: 'primary', route: 'faux', model: 'faux-1' } }],
      ['setYolo', { enabled: true, actor: operator }],
    ])
  })

  it('runs a turn and reports a worker crash without a turn-revision lease', async () => {
    let crashes = false
    const link = {
      alive: true,
      async command(method: string) {
        if (method === 'run' && crashes) throw new Error('worker crashed')
        return { reason: 'completed', lastSeq: 4 }
      },
    }
    const session = new RemoteSession('s', 'run', 1, link as never, '/workspace')
    await expect(
      session.run({ until: 'turn-end', signal: new AbortController().signal }),
    ).resolves.toMatchObject({ reason: 'completed', lastSeq: 4 })
    crashes = true
    await expect(session.run({ until: 'turn-end', signal: new AbortController().signal })).rejects.toThrow(
      'worker crashed',
    )
  })

  it.each(['before', 'during'] as const)(
    'forwards a cancel that arrived %s the run command to the worker, after the run itself',
    async (when) => {
      const sent: string[] = []
      let finish: (value: unknown) => void = () => undefined
      const link = {
        alive: true,
        async command(method: string) {
          sent.push(method)
          if (method === 'run') return new Promise((resolve) => (finish = resolve))
          return {}
        },
      }
      const session = new RemoteSession('s', 'run', 1, link as never, '/workspace')
      const controller = new AbortController()
      // A cancel that lands while the prompt is still being enqueued has already fired when run()
      // starts listening, so only an explicit check can deliver it.
      if (when === 'before') controller.abort()
      const running = session.run({ until: 'turn-end', signal: controller.signal })
      if (when === 'during') controller.abort()
      expect(sent).toEqual(['run', 'abort'])
      finish({ reason: 'aborted', lastSeq: 3 })
      await expect(running).resolves.toMatchObject({ reason: 'aborted' })
    },
  )

  it('still throws when the terminal ledger commit landed but its run reply was lost', async () => {
    const link = {
      alive: true,
      async command(method: string) {
        if (method === 'run') throw new Error('injected terminal reply loss')
        if (method === 'latest') return null
        throw new Error(`unexpected command ${method}`)
      },
    }
    const session = new RemoteSession('s', 'run', 1, link as never, '/workspace')
    await expect(session.run({ until: 'turn-end', signal: new AbortController().signal })).rejects.toThrow(
      'terminal reply loss',
    )
  })

  it('does not command a stale dead session proxy', async () => {
    let commandCalls = 0
    const link = {
      alive: false,
      async command() {
        commandCalls++
        throw new Error('unexpected command')
      },
    }
    const session = new RemoteSession('stale', 'run', 1, link as never, '/workspace')
    await expect(session.run({ until: 'turn-end', signal: new AbortController().signal })).rejects.toThrow(
      'worker link closed',
    )
    expect(commandCalls).toBe(0)
  })

  it('runs manual compaction without a turn-revision lease', async () => {
    const lifecycle: string[] = []
    let markerCommitted = true
    const link = {
      alive: true,
      async command(method: string) {
        lifecycle.push(`command:${method}`)
        if (method === 'manualCompact') {
          if (markerCommitted) return 7
          throw new Error('marker rejected')
        }
        if (method === 'latest') return markerCommitted ? { turnId: 'manual' } : null
        throw new Error(`unexpected command ${method}`)
      },
    }
    const session = new RemoteSession('compact', 'run', 1, link as never, '/workspace')
    const input = {
      actor: { id: 'owner', org: 'local', role: 'owner' as const, deptPath: [], attrs: {} },
      admissionId: 'compact-admission',
    }

    await expect(session.requestCompaction(input)).resolves.toBe(7)
    expect(lifecycle).toEqual(['command:manualCompact'])

    lifecycle.length = 0
    markerCommitted = false
    await expect(session.requestCompaction(input)).rejects.toThrow('marker rejected')
    expect(lifecycle).toEqual(['command:manualCompact', 'command:latest'])
  })

  it('keeps a manual compaction turn busy between its marker and terminal run', async () => {
    const link = {
      alive: true,
      async command(method: string) {
        if (method === 'manualCompact') return 7
        if (method === 'run') return { reason: 'completed', lastSeq: 8 }
        throw new Error(`unexpected command ${method}`)
      },
    }
    const session = new RemoteSession('compact-busy', 'run', 1, link as never, '/workspace')
    const input = {
      actor: { id: 'owner', org: 'local', role: 'owner' as const, deptPath: [], attrs: {} },
      admissionId: 'compact-busy-admission',
    }

    await expect(session.requestCompaction(input)).resolves.toBe(7)
    expect(session.running).toBe(true)
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(session.running).toBe(false)
  })

  it('does not create a manual-compaction lease through a stale dead session proxy', async () => {
    let commandCalls = 0
    const session = new RemoteSession(
      'stale-compact',
      'run',
      1,
      {
        alive: false,
        async command() {
          commandCalls++
          throw new Error('unexpected command')
        },
      } as never,
      '/workspace',
    )

    await expect(
      session.requestCompaction({
        actor: { id: 'owner', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        admissionId: 'stale-admission',
      }),
    ).rejects.toThrow('worker link closed')
    expect(commandCalls).toBe(0)
  })
})
