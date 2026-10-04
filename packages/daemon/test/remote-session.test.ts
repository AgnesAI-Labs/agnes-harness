import { canonicalJson, sha256Hex } from '@agnes/core'
import {
  type ConfigurationAdmissionPort,
  type ConfigurationAdmissionReceipt,
  comparisonPayloadDigest,
} from '@agnes/host'
import type { EventEnvelope } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { RemoteSession } from '../src/supervisor/remote-session.js'
import { handleCommand } from '../src/worker/commands.js'
import { openTestHost } from './host.js'

describe('RemoteSession switch result bridge', () => {
  it('preserves all three permission modes across worker admission with a distinct round source', async () => {
    const t = await openTestHost()
    try {
      const local = await t.host.createSession({ cwd: t.dataDir })
      const prepared = await t.host.prepareSessionConfiguration(local.key)
      const originalApproval = local.d.approvalMode
      const options = { host: t.host, aborts: new Map() }
      const owner = {
        sessionKey: local.key,
        writerRunId: local.writerRunId,
        generation: 1,
        workerGeneration: 1,
      }
      const commands: unknown[] = []
      const link = {
        alive: true,
        executionOwner: () => owner,
        command(method: Parameters<typeof handleCommand>[1]['method'], params: Record<string, unknown>) {
          commands.push({ method, params: structuredClone(params) })
          return handleCommand(local, { kind: 'command', requestId: 'round', method, params }, options)
        },
      }
      const remote = new RemoteSession(local.key, local.writerRunId, 1, link as never, t.dataDir)
      for (const permissionMode of ['full', 'workspace', 'view'] as const) {
        const input = {
          sessionId: local.key,
          inputId: `input-${permissionMode}`,
          payloadDigest: comparisonPayloadDigest([{ type: 'text', text: 'mode round trip' }]),
          prepared,
          permissionMode,
        }
        const receipt = await remote.acquireConfiguration(input)
        expect(commands).toContainEqual({
          method: 'configurationAdmission',
          params: { action: 'acquire', input },
        })
        expect(receipt.prepared.sourceSeq).toBeGreaterThan(prepared.sourceSeq)
        expect(receipt.prepared.sourceDigest).not.toBe(prepared.sourceDigest)
        expect(receipt.prepared.configuration.effective.permission).toMatchObject({
          approvalMode: permissionMode === 'full' ? 'off' : 'manual',
          yolo: false,
        })
        expect(local.d.approvalMode).toBe(permissionMode === 'full' ? 'off' : 'manual')
        expect(remote.running).toBe(true)
        await remote.checkConfiguration(receipt.token, true)
        await remote.releaseConfiguration(receipt.token)
        expect(local.d.approvalMode).toBe(originalApproval)
        expect(remote.running).toBe(false)
        expect(await t.host.prepareSessionConfiguration(local.key)).toEqual(prepared)
      }
      expect(await local.scan({ type: 'x/host/comparison-round-prepared', limit: 10 })).toHaveLength(3)
      expect(await local.scan({ type: 'turn/start', limit: 10 })).toEqual([])
    } finally {
      await t.close()
    }
  })

  it('rejects round source, owner and non-permission drift without clearing uncertain activity', async () => {
    const t = await openTestHost()
    try {
      const local = await t.host.createSession({ cwd: t.dataDir })
      const prepared = await t.host.prepareSessionConfiguration(local.key)
      const input = {
        sessionId: local.key,
        inputId: 'bound-round',
        payloadDigest: comparisonPayloadDigest([{ type: 'text', text: 'bound input' }]),
        prepared,
        permissionMode: 'full' as const,
      }
      const original = await t.host.configurationAdmissions.acquire(input)
      const start = await local.scan({ type: 'session/start', order: 'asc', limit: 1 })
      const [round] = await local.scan({
        fromSeq: original.prepared.sourceSeq,
        toSeq: original.prepared.sourceSeq,
        limit: 1,
      })
      if (!round) throw new Error('Missing round source')
      for (const fault of [
        'session',
        'writer',
        'input',
        'payload',
        'source-digest',
        'source-input',
        'source-mode',
        'source-type',
        'source-trust',
        'configuration',
        'approval',
        'yolo',
        'owner-read',
        'missing-source',
        'baseline-source',
      ] as const) {
        const receipt: ConfigurationAdmissionReceipt = structuredClone(original)
        const source: EventEnvelope = structuredClone(round)
        const data = source.data as {
          inputId: string
          permissionMode: string
          configuration: ConfigurationAdmissionReceipt['prepared']['configuration']
        }
        let generation = 1
        if (fault === 'session') receipt.sessionId = 'other'
        if (fault === 'writer') receipt.writerRunId = 'other'
        if (fault === 'input') receipt.inputId = 'other'
        if (fault === 'payload') receipt.payloadDigest = 'b'.repeat(64)
        if (fault === 'source-input') data.inputId = 'other'
        if (fault === 'source-mode') data.permissionMode = 'view'
        if (fault === 'source-type') source.type = 'x/host/session-prepared'
        if (fault === 'source-trust') source.trust = 'untrusted'
        if (fault === 'configuration') data.configuration.effective.preset.name = 'other'
        if (fault === 'approval') data.configuration.effective.permission.approvalMode = 'manual'
        if (fault === 'yolo') data.configuration.effective.permission.yolo = true
        receipt.prepared.configuration = structuredClone(data.configuration)
        receipt.prepared.sourceDigest = sha256Hex(canonicalJson(source))
        if (fault === 'source-digest') receipt.prepared.sourceDigest = 'b'.repeat(64)
        if (fault === 'baseline-source') receipt.prepared = prepared
        const link = {
          alive: true,
          executionOwner: () => ({
            sessionKey: local.key,
            writerRunId: local.writerRunId,
            generation,
            workerGeneration: generation,
          }),
          async command(method: string, params: Record<string, unknown>) {
            if (method === 'configurationAdmission' && params.action === 'acquire') return receipt
            if (method === 'scan') {
              if (fault === 'owner-read') generation++
              return params.type === 'session/start' ? start : fault === 'missing-source' ? [] : [source]
            }
            throw new Error('Unexpected command')
          },
        }
        const remote = new RemoteSession(local.key, local.writerRunId, 1, link as never, t.dataDir)
        await expect(remote.acquireConfiguration(input), fault).rejects.toThrow(
          /configuration (owner|preparation)/,
        )
        expect(remote.running, fault).toBe(true)
      }
      await t.host.configurationAdmissions.release(local.key, original.token)
    } finally {
      await t.close()
    }
  })

  it.each(['released', 'wrong-writer', 'wrong-input', 'replacement', 'lost-marker'] as const)(
    'keeps maintenance activity sticky unless exact persisted release is proved (%s)',
    async (mode) => {
      let generation = 1
      const input = {
        sessionId: 's',
        inputId: 'held-input',
        payloadDigest: 'a'.repeat(64),
        prepared: { sourceDigest: 'p' },
      } as Parameters<ConfigurationAdmissionPort['acquire']>[0]
      const link = {
        alive: true,
        executionOwner: () => ({
          sessionKey: 's',
          writerRunId: 'run',
          generation,
          workerGeneration: generation,
        }),
        async command(method: string, params: { action?: string }) {
          if (method === 'configurationAdmission' && params.action === 'acquire')
            return { ...input, token: 'token', writerRunId: 'run' }
          if (method === 'controlRuntime') {
            if (mode === 'replacement') generation++
            return {
              runtime: { id: 'jevloop', version: '1' },
              effectiveFromSeq: 10,
              result: { resolution: 'accepted_uncertainty' },
            }
          }
          if (method === 'latest') {
            if (mode === 'lost-marker') throw new Error('release proof unavailable')
            return {
              status: 'released',
              id: sha256Hex('token'),
              sessionId: 's',
              writerRunId: mode === 'wrong-writer' ? 'other' : 'run',
              commandId: mode === 'wrong-input' ? 'other' : 'held-input',
            }
          }
          throw new Error('unexpected command')
        },
      }
      const session = new RemoteSession('s', 'run', 1, link as never, '/workspace')
      await session.acquireConfiguration(input)
      const controlling = session.controlRuntime({
        actor: { id: 'owner', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        expectedRuntime: { id: 'jevloop', version: '1' },
        operation: 'jev.resolveUnknown',
        payload: {},
      })
      if (mode === 'lost-marker') await expect(controlling).rejects.toThrow('release proof unavailable')
      else if (mode === 'replacement') await expect(controlling).rejects.toThrow('maintenance owner changed')
      else
        await expect(controlling).resolves.toMatchObject({ result: { resolution: 'accepted_uncertainty' } })
      expect(session.running).toBe(mode !== 'released')
    },
  )

  it('revokes an in-flight idle acquisition on endpoint abort without granting a late token', async () => {
    const controller = new AbortController()
    let reply!: (value: { token: string }) => void
    const acquired = new Promise<{ token: string }>((resolve) => {
      reply = resolve
    })
    const commands: string[] = []
    const owner = { sessionKey: 's', writerRunId: 'run', generation: 1, workerGeneration: 1 }
    const link = {
      alive: true,
      executionOwner: () => owner,
      async command(_method: string, params: { action: string }) {
        commands.push(params.action)
        if (params.action === 'acquire') return acquired
      },
    }
    const session = new RemoteSession('s', 'run', 1, link as never, '/workspace')
    const waiting = session.acquireIdleGate(
      [{ sessionKey: 's', writerRunId: 'run', ownerEpoch: 1 }],
      controller.signal,
    )
    controller.abort()
    reply({ token: 'late-token' })
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(commands).toContain('cancelAcquire')
    expect(session.running).toBe(false)
  })
  it.each(['released', 'replacement', 'lost-acquisition', 'lost-reply-cleaned'] as const)(
    'keeps the idle gate exact-owner and fail-closed on %s',
    async (mode) => {
      let generation = 1
      const commands: string[] = []
      const link = {
        alive: true,
        executionOwner: () => ({
          sessionKey: 's',
          writerRunId: 'run',
          generation,
          workerGeneration: generation,
        }),
        async command(_method: string, params: { action: string }) {
          commands.push(params.action)
          if (mode === 'lost-acquisition') throw new Error('receipt lost')
          if (mode === 'lost-reply-cleaned' && params.action === 'acquire') throw new Error('receipt lost')
          return params.action === 'acquire' ? { token: 'idle-token' } : undefined
        },
      }
      const session = new RemoteSession('s', 'run', 1, link as never, '/workspace')
      const acquiring = session.acquireIdleGate([{ sessionKey: 's', writerRunId: 'run', ownerEpoch: 1 }])
      if (mode === 'lost-acquisition' || mode === 'lost-reply-cleaned') {
        await expect(acquiring).rejects.toThrow('receipt lost')
        expect(session.running).toBe(mode === 'lost-acquisition')
      } else {
        const gate = await acquiring
        expect(session.running).toBe(true)
        if (mode === 'replacement') {
          generation++
          await expect(gate.check()).rejects.toThrow('owner changed')
          await expect(gate.release()).rejects.toThrow('owner changed')
          expect(commands).toEqual(['acquire'])
          expect(session.running).toBe(true)
        } else {
          await gate.check()
          await gate.release()
          await gate.release()
          expect(session.running).toBe(false)
          await expect(gate.check()).rejects.toThrow('released')
        }
      }
    },
  )
  it.each([false, true, undefined])(
    'keeps failed configuration delivery sticky unless the exact owner proves held=%s',
    async (held) => {
      const owner = { sessionKey: 's', writerRunId: 'run', generation: 1, workerGeneration: 1 }
      const link = {
        alive: true,
        executionOwner: () => owner,
        async command(_method: string, params: { action: string; onlyMatching?: boolean }) {
          if (params.action === 'acquire') throw new Error('acquire reply lost')
          if (params.action === 'probe') {
            if (held === undefined) throw new Error('probe unavailable')
            return { sessionId: 's', writerRunId: 'run', held }
          }
          if (params.action === 'cancel') {
            expect(params.onlyMatching).toBe(true)
            return { inputId: 'i' }
          }
          throw new Error('unexpected command')
        },
      }
      const session = new RemoteSession('s', 'run', 1, link as never, '/workspace')
      const input = {
        sessionId: 's',
        inputId: 'i',
        payloadDigest: 'a'.repeat(64),
        prepared: { sourceDigest: 'p' },
      } as Parameters<ConfigurationAdmissionPort['acquire']>[0]
      await expect(session.acquireConfiguration(input)).rejects.toThrow('acquire reply lost')
      expect(session.running).toBe(held !== false)
      const actor = { id: 'owner', org: 'local', role: 'owner', deptPath: [], attrs: {} }
      await session.cancelConfiguration('i', actor, true)
      expect(session.running).toBe(false)
    },
  )

  it('binds configuration commands to both session and worker generation without reviving a replaced owner', async () => {
    let generation = 1
    const input = {
      sessionId: 's',
      inputId: 'i',
      payloadDigest: 'a'.repeat(64),
      prepared: { sourceDigest: 'p' },
    } as Parameters<ConfigurationAdmissionPort['acquire']>[0]
    const link = {
      alive: true,
      executionOwner: () => ({
        sessionKey: 's',
        writerRunId: 'run',
        generation,
        workerGeneration: generation,
      }),
      async command(_method: string, params: { action: string }) {
        if (params.action !== 'acquire') throw new Error('replacement must receive no command')
        return { ...input, token: 'private-token', writerRunId: 'run' }
      },
    }
    const session = new RemoteSession('s', 'run', 1, link as never, '/workspace')
    const receipt = await session.acquireConfiguration(input)
    generation++
    await expect(session.checkConfiguration(receipt.token)).rejects.toThrow('owner unavailable')
    await expect(session.enqueueConfiguration(receipt.token, {} as never)).rejects.toThrow(
      'owner unavailable',
    )
    expect(session.running).toBe(true)
  })

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
