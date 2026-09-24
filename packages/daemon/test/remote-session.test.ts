import { describe, expect, it } from 'vitest'
import { RemoteSession } from '../src/supervisor/remote-session.js'

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
