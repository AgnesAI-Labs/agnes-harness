import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import type { KernelChildren } from '@agnes/core'
import {
  comparisonPayloadDigest,
  createComparisonStore,
  createSqliteStorage,
  type HostSession,
  inspectComparisonInput,
} from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import type { JsonValue, Provider } from '@agnes/protocol'
import { createClient, memoryJournal } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createLocalEndpoint } from '../src/local/index.js'
import { say, testWorkspaceCatalog } from './host.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function gatedProvider() {
  const inner = new ScriptedProvider({
    scripts: [
      'First answer',
      'Second answer',
      'Third answer',
      'Fourth answer',
      'Fifth answer',
      'Sixth answer',
    ].map(say),
  })
  const started = deferred<void>()
  const gates = new Map<string, { signal: AbortSignal; finish: () => void }>()
  const provider: Provider = {
    models: () => inner.models(),
    async *infer(request, options) {
      const gate = deferred<void>()
      gates.set(request.sessionKey, { signal: options.signal, finish: () => gate.resolve() })
      if (gates.size === 2) started.resolve()
      const stop = () => gate.resolve()
      options.signal.addEventListener('abort', stop, { once: true })
      try {
        if (!options.signal.aborted) await gate.promise
        yield* inner.infer(request, options)
      } finally {
        options.signal.removeEventListener('abort', stop)
      }
    },
  }
  return {
    provider,
    started: started.promise,
    gates,
    finish: () => {
      for (const gate of gates.values()) gate.finish()
    },
  }
}
async function fixture(
  provider: Provider,
  approval?: import('@agnes/host/testkit').TestHostOptions['approval'],
) {
  const root = await mkdtemp(join(tmpdir(), 'agnes-comparison-rpc-'))
  const dataDir = join(root, 'data')
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  await writeFile(join(cwd, 'untracked.txt'), 'frozen source')
  const { host } = await createTestHost({
    dataDir,
    provider: (profile) => ({
      models: () => profile.provider.routes?.flatMap((route) => route.models ?? []) ?? [],
      infer: (request, options) => provider.infer(request, options),
    }),
    disableSessionTitle: true,
    platformCaps: { 'sandbox.l1': 'full' },
    presets: {
      standard: {
        name: 'standard',
        extends: 'base',
        disclosure: 'standard',
        sandbox: { level: 'L0', required: false, on_unavailable: 'allow' },
      },
    },
    ...(approval ? { approval } : {}),
    jev: {
      config: { responseReviewMode: 'diagnostic', answerProgressFloor: null },
      decision: {
        backend: 'jev',
        endpoint: 'https://jev.invalid/v1',
        model: 'jev-test',
        transport: {
          async invoke({ questions }) {
            const answers: Record<string, JsonValue> = {}
            for (const [name, value] of Object.entries(questions)) {
              const criteria = (value as { criteria?: Record<string, unknown> }).criteria
              if (!criteria || (name !== 'purpose' && name !== 'operation_RESPOND')) continue
              answers[name] = {
                type: 'choice',
                choice: 'RESPOND',
                confidence: 1,
                probabilities: Object.fromEntries(
                  Object.keys(criteria).map((key) => [key, key === 'RESPOND' ? 1 : 0]),
                ),
              }
            }
            return { output: { answers }, observedModel: 'jev-test' }
          },
        },
      },
    },
  })
  const ledger = createSqliteStorage({ file: join(dataDir, 'sessions.db') })
  const workspaces = await testWorkspaceCatalog(cwd)
  const opened = new Map<string, HostSession>()
  const enqueueErrors: unknown[] = []
  const hooks: {
    afterAcquire?: (sessionId: string) => Promise<void>
    afterEnqueue?: (sessionId: string) => Promise<void>
    beforeCreate?: (runtime: string | undefined) => Promise<void>
    afterCreate?: (session: HostSession) => Promise<void>
  } = {}
  const acquire = host.configurationAdmissions.acquire.bind(host.configurationAdmissions)
  vi.spyOn(host.configurationAdmissions, 'acquire').mockImplementation(async (...args) => {
    const receipt = await acquire(...args)
    await hooks.afterAcquire?.(receipt.sessionId)
    return receipt
  })
  const create = host.createSession.bind(host)
  vi.spyOn(host, 'createSession').mockImplementation(async (options) => {
    await hooks.beforeCreate?.(options.runtime)
    const session = await create(options)
    opened.set(session.key, session)
    await hooks.afterCreate?.(session)
    const enqueue = session.enqueue.bind(session)
    vi.spyOn(session, 'enqueue').mockImplementation(async (...args) => {
      try {
        const seq = await enqueue(...args)
        await hooks.afterEnqueue?.(session.key)
        return seq
      } catch (error) {
        enqueueErrors.push(error)
        throw error
      }
    })
    return session
  })
  const clients: ReturnType<typeof createClient>[] = []
  const connect = (principal = 'local') => {
    const endpoint = createLocalEndpoint(host, {
      dataDir,
      workspaces,
      pollMs: 5,
      comparisonLedger: {
        async head(sessionId) {
          return (await ledger.scan(sessionId, { order: 'desc', limit: 1 }))[0]?.seq ?? 0
        },
        scan: (sessionId, query) => ledger.scan(sessionId, query),
      },
    })
    // Exercise the real server-side transition from transport placeholder to authenticated identity.
    endpoint.establishPrincipal(principal)
    const client = createClient({ transport: { kind: 'inproc', endpoint }, journal: memoryJournal() })
    clients.push(client)
    return client
  }
  return {
    host,
    dataDir,
    cwd,
    ledger,
    opened,
    enqueueErrors,
    hooks,
    connect,
    async close() {
      await Promise.all(clients.map((client) => client.close()))
      await host.close()
      await ledger.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe('comparison through actual local endpoint and SDK', () => {
  it('keeps comparison lanes out of ordinary workspace and session navigation before selectors and paging', async () => {
    const f = await fixture(new ScriptedProvider({ scripts: [] }))
    try {
      const client = f.connect()
      const created = await client.comparison.create({
        requestId: 'navigation',
        cwd: f.cwd,
        left: { runtime: 'native' },
        right: { runtime: 'native' },
      })
      const normalIds = ['zz-normal-left', 'zz-normal-right']
      for (const name of ['left', 'right']) {
        const cwd = join(f.cwd, name)
        await mkdir(cwd)
        await client.workspace.add(cwd)
        await client.session.new({ cwd, sessionKey: `zz-normal-${name}` })
      }
      const listed = await client.workspace.list()
      expect(listed.items.map((item) => item.path).sort()).toEqual(
        (
          await Promise.all([f.cwd, join(f.cwd, 'left'), join(f.cwd, 'right')].map((path) => realpath(path)))
        ).sort(),
      )
      expect(listed.items.every((item) => !('comparisonOwned' in item))).toBe(true)
      const first = await client.session.list({ limit: 1 })
      expect(first.items.map((item) => item.sessionId)).toEqual([normalIds[0]])
      expect(first.next).toBeDefined()
      if (!first.next) throw new Error('Missing ordinary session pagination cursor')
      const second = await client.session.list({ limit: 1, cursor: first.next })
      expect(second.items.map((item) => item.sessionId)).toEqual([normalIds[1]])
      expect(second.next).toBeUndefined()
      for (const lane of created.lanes) {
        const cwd = f.opened.get(lane.sessionId)?.d.cwd
        if (!cwd) throw new Error('Missing comparison workspace binding')
        for (const q of [{ prefix: lane.sessionId }, { text: lane.sessionId }, { cwd }])
          expect((await client.session.list({ q, limit: 1 })).items).toEqual([])
        await expect(client.workspace.add(cwd)).rejects.toMatchObject({
          data: { code: 'WORKSPACE_NOT_FOUND' },
        })
      }
      const reconnected = f.connect()
      expect((await reconnected.workspace.list()).items.map((item) => item.path).sort()).toEqual(
        listed.items.map((item) => item.path).sort(),
      )
      expect((await reconnected.session.list()).items).toEqual([])
      expect((await reconnected.comparison.get(created.id)).lanes).toEqual(created.lanes)
    } finally {
      await f.close()
    }
  })

  it('returns a stable preparation-busy receipt and closes provisional owners while an earlier configuration is pinned', async () => {
    const provider = new ScriptedProvider({ scripts: [] })
    const f = await fixture(provider)
    try {
      const client = f.connect()
      const created = await client.comparison.create({
        requestId: 'existing-held',
        cwd: f.cwd,
        left: { runtime: 'native' },
        right: { runtime: 'jevloop' },
      })
      const lane = created.lanes[0]
      if (!lane) throw new Error('Missing prepared owner')
      const prepared = created.prepared?.[lane.side]
      if (!prepared) throw new Error('Missing configuration receipt')
      const receipt = await f.host.configurationAdmissions.acquire({
        sessionId: lane.sessionId,
        inputId: 'reserved',
        payloadDigest: comparisonPayloadDigest([]),
        prepared,
      })
      try {
        await expect(
          client.comparison.create({
            requestId: 'busy-new',
            cwd: f.cwd,
            left: { runtime: 'native' },
            right: { runtime: 'jevloop' },
          }),
        ).rejects.toMatchObject({ data: { code: 'COMPARISON_PREPARATION_BUSY' } })
        const store = createComparisonStore(join(f.dataDir, 'comparisons', 'index.sqlite'))
        try {
          const failed = await store.scoped('local').read('busy-new')
          expect(failed?.creation).toBe('failed')
          expect(failed?.lanes).toEqual({})
          expect(failed?.error).toBeDefined()
          const bindings = await store.scoped('local').reservedBindings('busy-new')
          for (const key of Object.values(bindings)) expect(f.host.kernel.get(key)?.d.log.isClosed).toBe(true)
        } finally {
          store.close()
        }
        expect(provider.calls).toHaveLength(0)
      } finally {
        await f.host.configurationAdmissions.release(lane.sessionId, receipt.token)
      }
      await expect(
        client.comparison.create({
          requestId: 'after-release',
          cwd: f.cwd,
          left: { runtime: 'native' },
          right: { runtime: 'jevloop' },
        }),
      ).resolves.toMatchObject({ phase: 'ready' })
    } finally {
      await f.close()
    }
  })

  it('returns stable public not-found and preparation errors without exposing backend exception data', async () => {
    const f = await fixture(new ScriptedProvider({ scripts: [] }))
    try {
      const client = f.connect()
      const id = 'conformance-never-created'
      for (const request of [
        () => client.comparison.get(id),
        () => client.comparison.reconcile(id),
        () => client.comparison.cancel({ id, inputId: 'missing-input' }),
        () =>
          client.comparison.submit({
            id,
            inputId: 'missing-input',
            content: [{ type: 'text', text: 'private request payload' }],
          }),
      ]) {
        const error = await request().catch((cause: unknown) => cause)
        expect(error).toMatchObject({ code: -32011 })
        expect((error as { data: unknown }).data).toEqual({ code: 'COMPARISON_NOT_FOUND' })
      }
      // A dangling link is refused before any owner opens, with only its bounded public cause.
      await symlink(join(f.cwd, 'private-missing-target'), join(f.cwd, 'shortcut'))
      const params = {
        requestId: 'unsupported-snapshot',
        cwd: f.cwd,
        left: { runtime: 'native' },
        right: { runtime: 'native' },
      }
      const failure = await client.comparison.create(params).catch((cause: unknown) => cause)
      expect(failure).toMatchObject({ code: -32011 })
      const data = (failure as { data: { code: string } }).data
      expect(data.code).toBe('WORKSPACE_SYMLINK_UNRESOLVED')
      expect(Object.keys(data)).toEqual(['code'])
      expect(JSON.stringify(failure)).not.toContain('private-missing-target')
      for (const operation of [
        () => client.comparison.get(params.requestId),
        () => client.comparison.create(params),
      ])
        expect(await operation().catch((cause: unknown) => cause)).toMatchObject({ code: -32011, data })
      expect(f.opened.size).toBe(0)
      expect((await client.comparison.list()).items).toContainEqual(
        expect.objectContaining({ id: 'unsupported-snapshot', phase: 'failed' }),
      )
    } finally {
      await f.close()
    }
  })

  it('settles cancellation admitted during a blocking hook without dispatching that lane', async () => {
    const captured = JSON.parse(
      await readFile(new URL('./fixtures/comparison-hook-cancel-real.json', import.meta.url), 'utf8'),
    ) as {
      evidence: {
        inferenceEntered: { seq: number }
        cancelRequested: { seq: number; control: string }
        turnEnd: { seq: number; data: { reason: string; error: { code: string; message: string } } }
        admissionReleasedSeq: number
        dispatchEvents: string[]
      }
    }
    expect(captured.evidence.cancelRequested.control).toBe('cancel_requested')
    expect(captured.evidence.inferenceEntered.seq).toBeLessThan(captured.evidence.cancelRequested.seq)
    expect(captured.evidence.cancelRequested.seq).toBeLessThan(captured.evidence.turnEnd.seq)
    expect(captured.evidence.turnEnd.data.reason).toBe('blocked')
    expect(captured.evidence.dispatchEvents).toEqual([])
    const provider = new ScriptedProvider({ scripts: [say('peer')] })
    const f = await fixture(provider)
    try {
      const entered = deferred<void>()
      const client = f.connect()
      const created = await client.comparison.create({
        requestId: 'hook-cancel',
        cwd: f.cwd,
        left: { runtime: 'native' },
        right: { runtime: 'jevloop' },
      })
      const lane = created.lanes.find((value) => value.side === 'left')!
      const left = f.opened.get(lane.sessionId)!
      const hooks = left.hooks
      vi.spyOn(left, 'hooks', 'get').mockReturnValue(
        new Proxy(hooks, {
          get(target, key, receiver) {
            if (key !== 'beforeStep') return Reflect.get(target, key, receiver)
            return async () => {
              const signal = left.ac.signal
              entered.resolve()
              await new Promise<void>((resolve) => {
                if (signal.aborted) resolve()
                else signal.addEventListener('abort', () => resolve(), { once: true })
              })
              return { block: true, reason: captured.evidence.turnEnd.data.error.message }
            }
          },
        }),
      )
      const submitted = await client.comparison.submit({
        id: created.id,
        inputId: 'hook-input',
        content: [{ type: 'text', text: 'cancel at hook boundary' }],
      })
      expect(submitted.acceptances.every((value) => value.status === 'accepted')).toBe(true)
      await entered.promise
      const cancelled = await client.comparison.cancel({ id: created.id, side: 'left' })
      expect(cancelled.rounds[0]?.settledSides).toContain('left')
      expect(cancelled.rounds[0]?.terminalCauses).toContainEqual({ side: 'left', cause: 'cancelled' })
      expect(left.executionActive).toBe(false)
      expect(left.op()).toBeNull()
      expect(left.configurationReserved).toBe(false)
      expect(provider.calls.filter((request) => request.sessionKey === left.key)).toEqual([])
      expect((await left.scan({ type: 'turn/end', limit: 10 })).at(-1)?.data).toMatchObject({
        reason: 'aborted',
      })
      const store = createComparisonStore(join(f.dataDir, 'comparisons', 'index.sqlite'))
      try {
        expect((await store.scoped('local').read(created.id))?.cancellation.left).toBe('acknowledged')
      } finally {
        store.close()
      }
    } finally {
      await f.close()
    }
  })
  it('reports frozen configuration drift before accepting any input', async () => {
    const f = await fixture(new ScriptedProvider({ scripts: [] }))
    try {
      const client = f.connect()
      const created = await client.comparison.create({
        requestId: 'prepared-drift',
        cwd: f.cwd,
        left: { runtime: 'native' },
        right: { runtime: 'jevloop' },
      })
      const session = f.opened.get(created.lanes[0]!.sessionId)!
      const model = session.d.provider.models()[0]!
      await session.setModel({
        slot: 'primary',
        route: model.route,
        model: model.id,
        contextWindow: 2048,
      })
      await expect(
        client.comparison.submit({
          id: created.id,
          inputId: 'not-admitted',
          content: [{ type: 'text', text: 'preserve draft' }],
        }),
      ).rejects.toMatchObject({
        data: {
          code: 'COMPARISON_NOT_READY',
          phase: 'pre-admission',
          inputAccepted: false,
          admissionReason: 'configuration-changed',
        },
      })
      expect((await client.comparison.get(created.id)).rounds).toEqual([])
      for (const session of f.opened.values()) {
        expect(await session.scan({ type: 'user/message', limit: 10 })).toEqual([])
        expect(session.configurationReserved).toBe(false)
      }
    } finally {
      await f.close()
    }
  })

  it('freezes isolated approval permissions per round without changing the creation baseline or earlier history', async () => {
    const gate = gatedProvider()
    const f = await fixture(gate.provider)
    try {
      const client = f.connect()
      const created = await client.comparison.create({
        requestId: 'round-permissions',
        cwd: f.cwd,
        permissionMode: 'full',
        left: { runtime: 'native' },
        right: { runtime: 'jevloop' },
      })
      expect(created.permissionMode).toBe('full')
      const priorModes = new Map([...f.opened].map(([key, session]) => [key, session.d.approvalMode]))
      const history: typeof created.rounds = []
      for (const permissionMode of ['full', 'workspace', 'view'] as const) {
        gate.gates.clear()
        const input = {
          id: created.id,
          inputId: `round-${permissionMode}`,
          content: [{ type: 'text' as const, text: `Answer in ${permissionMode} mode` }],
          ...(permissionMode === 'full' ? {} : { permissionMode }),
        }
        const round = await client.comparison.submit(input)
        const submitted = await client.comparison.get(created.id)
        expect(submitted.permissionMode).toBe(permissionMode)
        expect(submitted.prepared).toEqual(created.prepared)
        expect(submitted.rounds.slice(0, -1)).toEqual(history)
        expect(round.permissionMode).toBe(permissionMode)
        expect(round.acceptances.map((item) => item.status)).toEqual(['accepted', 'accepted'])
        await vi.waitFor(() => expect(gate.gates.size).toBe(2))
        for (const lane of created.lanes) {
          const session = f.opened.get(lane.sessionId)
          const prepared = round.prepared?.[lane.side]
          const baseline = created.prepared?.[lane.side]
          if (!session || !prepared || !baseline) throw new Error('Missing prepared comparison lane')
          expect(prepared.configuration.effective.permission).toMatchObject({
            approvalMode: permissionMode === 'full' ? 'off' : 'manual',
            yolo: false,
            enforcement: { level: 'full', scope: expect.arrayContaining(['file']) },
          })
          expect(prepared.sourceSeq).toBeGreaterThan(baseline.sourceSeq)
          expect(
            await session.scan({ fromSeq: prepared.sourceSeq, toSeq: prepared.sourceSeq }),
          ).toMatchObject([
            {
              type: 'x/host/comparison-round-prepared',
              data: { inputId: input.inputId, permissionMode, configuration: prepared.configuration },
            },
          ])
          expect(session.yolo).toBe(false)
          expect(session.d.approvalMode).toBe(permissionMode === 'full' ? 'off' : 'manual')
          await expect(session.setYolo(true, session.d.actor)).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
          await expect(session.setPreset(structuredClone(session.preset))).rejects.toMatchObject({
            code: 'E_LANE_BUSY',
          })
          await expect(
            session.setModel({ slot: 'primary', route: 'faux', model: 'faux-1' }),
          ).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
        }
        await expect(
          client.comparison.submit({
            ...input,
            permissionMode: permissionMode === 'full' ? 'workspace' : 'full',
          }),
        ).rejects.toMatchObject({ data: { code: 'IDEMPOTENCY_CONFLICT' } })
        gate.finish()
        await vi.waitFor(async () =>
          expect((await client.comparison.get(created.id)).phase).toBe('completed'),
        )
        const settled = await client.comparison.get(created.id)
        expect(settled.prepared).toEqual(created.prepared)
        expect(settled.rounds.slice(0, -1)).toEqual(history)
        const finishedRound = settled.rounds.at(-1)
        if (!finishedRound) throw new Error('Missing settled round')
        history.push(finishedRound)
        for (const [key, session] of f.opened) {
          expect(session.configurationReserved).toBe(false)
          expect(session.d.approvalMode).toBe(priorModes.get(key))
          expect(session.yolo).toBe(false)
        }
      }
      const final = await client.comparison.get(created.id)
      expect(final.rounds.map((round) => round.permissionMode)).toEqual(['full', 'workspace', 'view'])
      for (const lane of created.lanes)
        expect(
          final.rounds.map(
            (round) => round.prepared?.[lane.side]?.configuration.effective.permission.approvalMode,
          ),
        ).toEqual(['off', 'manual', 'manual'])
    } finally {
      gate.finish()
      await f.close()
    }
  })

  it.each(['left', 'right'] as const)(
    'restores both approval owners after the %s round preparation source fails and permits retry',
    async (side) => {
      const f = await fixture(new ScriptedProvider({ scripts: [say('retry left'), say('retry right')] }))
      try {
        const client = f.connect()
        const created = await client.comparison.create({
          requestId: `round-source-failure-${side}`,
          cwd: f.cwd,
          left: { runtime: 'native' },
          right: { runtime: 'jevloop' },
        })
        const priorModes = new Map([...f.opened].map(([key, session]) => [key, session.d.approvalMode]))
        const failedLane = created.lanes.find((lane) => lane.side === side)
        const failedSession = failedLane && f.opened.get(failedLane.sessionId)
        if (!failedSession) throw new Error('Missing lane for source failure')
        const append = failedSession.d.log.append.bind(failedSession.d.log)
        let fail = true
        vi.spyOn(failedSession.d.log, 'append').mockImplementation(async (...args) => {
          if (fail && args[0].some((event) => event.type === 'x/host/comparison-round-prepared')) {
            fail = false
            throw new Error('round preparation source write failed')
          }
          return append(...args)
        })
        const input = {
          id: created.id,
          inputId: 'retryable-permission-input',
          permissionMode: 'full' as const,
          content: [{ type: 'text' as const, text: 'Execute only after both owners are ready' }],
        }
        await expect(client.comparison.submit(input)).rejects.toMatchObject({
          data: { code: 'COMPARISON_NOT_READY', inputAccepted: false },
        })
        expect(fail).toBe(false)
        expect((await client.comparison.get(created.id)).rounds).toEqual([])
        for (const [key, session] of f.opened) {
          expect(session.configurationReserved).toBe(false)
          expect(session.d.approvalMode).toBe(priorModes.get(key))
          expect(session.yolo).toBe(false)
          expect(await session.scan({ type: 'user/message', limit: 10 })).toEqual([])
          expect(await session.scan({ type: 'request/sent', limit: 10 })).toEqual([])
        }
        const retried = await client.comparison.submit(input)
        expect(retried.acceptances.map((item) => item.status)).toEqual(['accepted', 'accepted'])
        await vi.waitFor(async () =>
          expect((await client.comparison.get(created.id)).phase).toBe('completed'),
        )
        for (const [key, session] of f.opened) {
          expect(session.configurationReserved).toBe(false)
          expect(session.d.approvalMode).toBe(priorModes.get(key))
        }
        expect((await client.comparison.get(created.id)).prepared).toEqual(created.prepared)
      } finally {
        await f.close()
      }
    },
  )

  it('completes the shared input in both lanes after cancelled canonical reports already queued', async () => {
    const f = await fixture(
      new ScriptedProvider({
        scripts: [say('REPORT_LEFT'), say('USER_LEFT'), say('REPORT_RIGHT'), say('USER_RIGHT')],
      }),
      async () => 'allowed-once',
    )
    try {
      const client = f.connect()
      const created = await client.comparison.create({
        requestId: 'pending-reports',
        cwd: f.cwd,
        left: { runtime: 'native' },
        right: { runtime: 'jevloop' },
      })
      for (const lane of created.lanes) {
        const parent = f.opened.get(lane.sessionId)
        if (!parent) throw new Error('Missing lane')
        const childHandle = await (parent.d.children as KernelChildren).createWithKind('spawn', {
          parent: parent.key,
          cwd: parent.d.cwd,
          input: 'child',
          isolation: 'shared',
        })
        const child = f.host.kernel.get(childHandle.key)
        if (!child) throw new Error('Missing child')
        await parent.abort(parent.d.actor)
        await (child.d.children as KernelChildren).sendMessage(parent.key, 'CANCELLED_OLD_REPORT', {
          deliveryId: 'old-report',
          parentEffectId: 'call',
          signal: new AbortController().signal,
        })
      }
      const result = await client.comparison.submit({
        id: created.id,
        inputId: 'new-shared-user',
        content: [{ type: 'text', text: 'EXPLICIT_SHARED_USER' }],
      })
      expect(result.acceptances.map((value) => value.status)).toEqual(['accepted', 'accepted'])
      await vi.waitFor(async () => expect((await client.comparison.get(created.id)).phase).toBe('completed'))
      const snapshot = await client.comparison.get(created.id)
      expect(snapshot.rounds[0]?.settledSides).toEqual(['left', 'right'])
      for (const lane of created.lanes) {
        const session = f.opened.get(lane.sessionId)!
        expect(session.latest('inbox')).toMatchObject({ items: [] })
        const messages = await session.scan({ type: 'user/message', order: 'asc', limit: 10 })
        expect(JSON.stringify(messages.at(-1)?.data)).toContain('EXPLICIT_SHARED_USER')
        expect(await session.scan({ type: 'turn/start', limit: 10 })).toHaveLength(2)
        expect(snapshot.rounds[0]?.terminalCauses).toContainEqual({ side: lane.side, cause: 'finished' })
      }
    } finally {
      await f.close()
    }
  })
  it('durably cancels an exact pending input during pre-CAS acquisition without admitting its late reply', async () => {
    const f = await fixture(new ScriptedProvider({ scripts: [say('new left'), say('new right')] }))
    const entered = deferred<void>()
    const proceed = deferred<void>()
    try {
      const client = f.connect()
      const created = await client.comparison.create({
        requestId: 'cancel-exact-pre-cas',
        cwd: f.cwd,
        left: { runtime: 'native' },
        right: { runtime: 'native' },
      })
      f.hooks.afterAcquire = async () => {
        entered.resolve()
        await proceed.promise
      }
      const input = {
        id: created.id,
        inputId: 'precise-pending',
        content: [{ type: 'text' as const, text: 'must never execute' }],
      }
      const submitting = client.comparison.submit(input)
      const rejected = expect(submitting).rejects.toMatchObject({
        data: { code: 'COMPARISON_NOT_READY', inputId: input.inputId },
      })
      await entered.promise
      const cancelled = await client.comparison.cancel({ id: created.id, inputId: input.inputId })
      expect(cancelled.rounds).toEqual([])
      expect(cancelled.inputCancellations).toEqual([
        {
          inputId: input.inputId,
          states: [
            { side: 'left', status: 'acknowledged' },
            { side: 'right', status: 'acknowledged' },
          ],
        },
      ])
      proceed.resolve()
      await rejected
      delete f.hooks.afterAcquire
      await expect(f.connect().comparison.submit(input)).rejects.toMatchObject({
        data: { code: 'COMPARISON_NOT_READY' },
      })
      for (const session of f.opened.values()) {
        expect(session.configurationReserved).toBe(false)
        expect(await session.scan({ type: 'user/message', limit: 10 })).toEqual([])
        expect(await session.scan({ type: 'request/sent', limit: 10 })).toEqual([])
      }
      await client.comparison.submit({
        ...input,
        inputId: 'new-explicit-command',
        content: [{ type: 'text', text: 'new input' }],
      })
      await vi.waitFor(async () => expect((await client.comparison.get(created.id)).phase).toBe('completed'))
    } finally {
      proceed.resolve()
      await f.close()
    }
  })

  it('explicitly cancels a lost pre-CAS reservation from its trusted input coordinate without recovering its run capability', async () => {
    const f = await fixture(new ScriptedProvider({ scripts: [say('fresh left'), say('fresh right')] }))
    try {
      const client = f.connect()
      const created = await client.comparison.create({
        requestId: 'pre-cas-loss',
        cwd: f.cwd,
        left: { runtime: 'native' },
        right: { runtime: 'native' },
      })
      const priorModes = new Map([...f.opened].map(([key, session]) => [key, session.d.approvalMode]))
      f.hooks.afterAcquire = async () => {
        throw new Error('acquisition reply lost')
      }
      const input = {
        id: created.id,
        inputId: 'before-cas',
        permissionMode: 'full' as const,
        content: [{ type: 'text' as const, text: 'No prompt was enqueued' }],
      }
      await expect(client.comparison.submit(input)).rejects.toMatchObject({
        data: { code: 'COMPARISON_NOT_READY', inputId: input.inputId, inputAccepted: false },
      })
      expect((await client.comparison.get(created.id)).rounds).toEqual([])
      expect([...f.opened.values()].some((session) => session.configurationReserved)).toBe(true)
      for (const session of f.opened.values()) {
        if (session.configurationReserved) expect(session.d.approvalMode).toBe('off')
        expect(session.yolo).toBe(false)
      }
      for (const session of f.opened.values())
        expect(await session.scan({ type: 'user/message', limit: 10 })).toEqual([])
      await client.comparison.cancel({ id: created.id })
      expect([...f.opened.values()].every((session) => !session.configurationReserved)).toBe(true)
      for (const [key, session] of f.opened) expect(session.d.approvalMode).toBe(priorModes.get(key))
      delete f.hooks.afterAcquire
      await expect(client.comparison.submit(input)).rejects.toMatchObject({
        data: { code: 'COMPARISON_NOT_READY' },
      })
      const resumed = await client.comparison.submit({ ...input, inputId: 'new-after-cancel' })
      expect(resumed.acceptances.map((value) => value.status)).toEqual(['accepted', 'accepted'])
      await vi.waitFor(async () => {
        expect((await client.comparison.get(created.id)).phase).toBe('completed')
      })
      for (const [key, session] of f.opened) expect(session.d.approvalMode).toBe(priorModes.get(key))
    } finally {
      await f.close()
    }
  })

  it('fences raw root-session mutations across connections without revoking history or cancellation', async () => {
    const provider = new ScriptedProvider({ scripts: [] })
    const infer = vi.spyOn(provider, 'infer')
    const f = await fixture(provider)
    try {
      const client = f.connect()
      const created = await client.comparison.create({
        requestId: 'fenced-roots',
        cwd: f.cwd,
        left: { runtime: 'native' },
        right: { runtime: 'jevloop' },
      })
      const lane = created.lanes.find((lane) => lane.side === 'left')
      if (!lane) throw new Error('missing comparison lane')
      const session = f.opened.get(lane.sessionId)
      if (!session) throw new Error('missing root session')
      const before = session.lastSeq
      const storage = createComparisonStore(join(f.dataDir, 'comparisons', 'index.sqlite'))
      try {
        const scoped = storage.scoped('local')
        const record = await scoped.read(created.id)
        if (!record) throw new Error('missing comparison')
        expect(
          await scoped.compareAndSwap(record.id, record.revision, {
            ...record,
            revision: record.revision + 1,
            retirement: { state: 'releasing', epoch: record.revision + 1 },
          }),
        ).toBe(true)
      } finally {
        storage.close()
      }
      const rejected = { data: { code: 'COMPARISON_ADMISSION_BLOCKED' } }
      await expect(
        client.call('session/prompt', {
          sessionId: lane.sessionId,
          prompt: [{ type: 'text', text: 'must not execute' }],
        }),
      ).rejects.toMatchObject(rejected)
      await expect(
        client.call('_agnes/v1/session.setModel', {
          sessionId: lane.sessionId,
          slot: 'primary',
          route: session.preset.model.route.primary,
          model: session.preset.model.id.primary,
        }),
      ).rejects.toMatchObject(rejected)
      await expect(
        client.call('session/load', { sessionId: lane.sessionId, cwd: session.d.cwd, mcpServers: [] }),
      ).rejects.toMatchObject(rejected)
      await expect(
        f.connect().call('session/load', { sessionId: lane.sessionId, cwd: session.d.cwd, mcpServers: [] }),
      ).rejects.toMatchObject(rejected)
      expect(
        await client.call('_agnes/v1/session.projectUI', { sessionId: lane.sessionId, surface: 'web' }),
      ).toMatchObject({ upto: before })
      expect((await client.comparison.get(created.id)).id).toBe(created.id)
      await client.comparison.cancel({ id: created.id })
      expect(infer).not.toHaveBeenCalled()
      expect(session.lastSeq).toBe(before)
    } finally {
      await f.close()
    }
  })

  it('retains both snapshot roots when an actual owner exists behind a lost creation reply', async () => {
    const f = await fixture(new ScriptedProvider({ scripts: [] }))
    try {
      f.hooks.afterCreate = async (session) => {
        if (session.runtimeIdentity.id === 'jevloop') throw new Error('creation reply lost after opening')
      }
      const client = f.connect()
      await expect(
        client.comparison.create({
          requestId: 'unknown-created-owner',
          cwd: f.cwd,
          left: { runtime: 'native' },
          right: { runtime: 'jevloop' },
        }),
      ).rejects.toThrow()
      expect(f.opened.size).toBe(2)
      expect((await client.comparison.list()).items).toEqual([
        expect.objectContaining({ id: 'unknown-created-owner', phase: 'failed', inspectable: false }),
      ])
      const storage = createComparisonStore(join(f.dataDir, 'comparisons', 'index.sqlite'))
      try {
        const record = await storage.scoped('local').read('unknown-created-owner')
        expect(record?.creation).toBe('failed')
        expect(record?.cleanup).toEqual({ exited: ['left'], released: false })
        for (const session of f.opened.values())
          expect(await readFile(join(session.d.cwd, 'untracked.txt'), 'utf8')).toBe('frozen source')
      } finally {
        storage.close()
      }
    } finally {
      await f.close()
    }
  })
  it('freezes defaults once before both owners open and preserves selection across request retries', async () => {
    const f = await fixture(new ScriptedProvider({ scripts: [] }))
    const updated = deferred<void>()
    try {
      const initial = await f.host.resolveSessionSelection({})
      const next = structuredClone(f.host.profile)
      const route = next.provider.routes![0]!
      route.models = [{ ...route.models![0]!, id: 'new-default', name: 'new-default' }, ...route.models!]
      f.hooks.beforeCreate = async (runtime) => {
        if (runtime === 'jevloop') await updated.promise
      }
      f.hooks.afterCreate = async (session) => {
        if (session.runtimeIdentity.id === 'native') {
          await f.host.applyModelProfile(next)
          updated.resolve()
        }
      }
      const client = f.connect()
      const input = {
        requestId: 'frozen-defaults',
        cwd: f.cwd,
        left: { runtime: 'native' },
        right: { runtime: 'jevloop' },
      }
      const created = await client.comparison.create(input)
      expect(created.phase).toBe('ready')
      expect((await f.host.resolveSessionSelection({})).model.model).toBe('new-default')
      for (const lane of created.lanes) {
        const session = f.opened.get(lane.sessionId)!
        expect(session.runtimeIdentity).toEqual(lane.runtime)
        expect(session.preset.name).toBe(initial.preset)
        expect(session.preset.model.route.primary).toBe(initial.model.route)
        expect(session.preset.model.id.primary).toBe(initial.model.model)
        expect(session.preset.model.contextWindow!.primary).toBe(initial.model.contextWindow)
      }
      const storage = createComparisonStore(join(f.dataDir, 'comparisons', 'index.sqlite'))
      try {
        expect((await storage.scoped('local').read(created.id))?.selection).toEqual(initial)
      } finally {
        storage.close()
      }
      expect(await f.connect().comparison.create(input)).toEqual(created)
      expect(f.opened.size).toBe(2)
    } finally {
      updated.resolve()
      await f.close()
    }
  })
  it.each(['jevloop', 'native'])(
    'runs Native + %s concurrently with durable independent receipts and roots',
    async (rightRuntime) => {
      const gate = gatedProvider()
      const f = await fixture(gate.provider)
      try {
        const client = f.connect()
        const created = await client.comparison.create({
          requestId: 'stable',
          cwd: f.cwd,
          left: { runtime: 'native' },
          right: { runtime: rightRuntime },
        })
        const createConflict = await client.comparison
          .create({
            requestId: created.id,
            cwd: join(f.cwd, 'private-path'),
            left: { runtime: 'native' },
            right: { runtime: rightRuntime },
          })
          .catch((cause: unknown) => cause)
        expect(createConflict).toMatchObject({ code: -32011 })
        expect((createConflict as { data: unknown }).data).toEqual({ code: 'IDEMPOTENCY_CONFLICT' })
        expect(created.lanes.map((lane) => lane.runtime.id)).toEqual(['native', rightRuntime])
        for (const lane of created.lanes) {
          const receipt = created.prepared?.[lane.side]
          expect(receipt?.sessionId).toBe(lane.sessionId)
          expect(receipt?.configuration.runtime).toEqual(lane.runtime)
          expect(f.opened.get(lane.sessionId)?.preset.sandbox.onUnavailable).toBe('deny')
          expect(receipt?.configuration.effective.permission.enforcement).toMatchObject({
            level: 'full',
            scope: expect.arrayContaining(['file']),
          })
          expect(
            receipt?.configuration.effective.models.find((model) => model.slot === 'primary'),
          ).toMatchObject({
            route: f.opened.get(lane.sessionId)!.preset.model.route.primary,
            model: f.opened.get(lane.sessionId)!.preset.model.id.primary,
          })
          expect(JSON.stringify(receipt)).not.toContain(f.cwd)
        }
        const roots = created.lanes.map((lane) => f.opened.get(lane.sessionId)!.d.cwd)
        expect(new Set(roots).size).toBe(2)
        for (const root of roots)
          expect(await readFile(join(root, 'untracked.txt'), 'utf8')).toBe('frozen source')
        const input = {
          id: created.id,
          inputId: 'one',
          content: [{ type: 'text' as const, text: 'Answer once' }],
        }
        const round = await client.comparison.submit(input)
        expect(f.enqueueErrors).toEqual([])
        expect(round.acceptances.map((acceptance) => acceptance.status)).toEqual(['accepted', 'accepted'])
        await gate.started
        expect(gate.gates.size).toBe(2)
        expect(await client.comparison.submit(input)).toEqual(round)
        const inputConflict = await client.comparison
          .submit({ ...input, content: [{ type: 'text', text: 'different private payload' }] })
          .catch((cause: unknown) => cause)
        expect(inputConflict).toMatchObject({ code: -32011 })
        expect((inputConflict as { data: unknown }).data).toEqual({ code: 'IDEMPOTENCY_CONFLICT' })
        const storage = createComparisonStore(join(f.dataDir, 'comparisons', 'index.sqlite'))
        try {
          const durable = await storage.scoped('local').read(created.id)
          expect(durable?.rounds[0]?.acceptances.left).toEqual(round.acceptances[0])
          expect(durable?.rounds[0]?.acceptances.right).toEqual(round.acceptances[1])
          if (!durable?.prepared?.left) throw new Error('Expected frozen preparation source')
          const head = await storage.scoped('local').journal.head(created.id)
          const conflicting = structuredClone(durable)
          conflicting.revision++
          if (!conflicting.prepared?.left) throw new Error('Expected detached preparation source')
          conflicting.prepared.left.sourceDigest = '0'.repeat(64)
          await expect(
            storage.scoped('local').compareAndSwap(created.id, durable.revision, conflicting),
          ).rejects.toMatchObject({
            code: 'JOURNAL_IDENTITY_CONFLICT',
          })
          expect(await storage.scoped('local').journal.head(created.id)).toEqual(head)
          expect(await storage.scoped('local').read(created.id)).toEqual(durable)
        } finally {
          storage.close()
        }
        gate.finish()
        await vi.waitFor(async () => {
          expect((await client.comparison.get(created.id)).phase).toBe('completed')
        })
        const firstPage = await client.comparison.journal({ id: created.id, limit: 2 })
        const journal = [...firstPage.entries]
        let cursor = firstPage.nextAfterSeq
        while (cursor < firstPage.throughSeq) {
          const page = await client.comparison.journal({
            id: created.id,
            afterSeq: cursor,
            throughSeq: firstPage.throughSeq,
            limit: 3,
          })
          expect(page.throughSeq).toBe(firstPage.throughSeq)
          journal.push(...page.entries)
          cursor = page.nextAfterSeq
        }
        expect(journal.map((entry) => entry.seq)).toEqual(
          Array.from({ length: firstPage.throughSeq }, (_, index) => index + 1),
        )
        const metrics = await client.comparison.metrics({ id: created.id, atSeq: firstPage.throughSeq })
        expect(metrics.summary?.roundCount).toBe(1)
        expect(metrics.summary?.inputId).toBe('one')
        expect(metrics.summary?.lanes).toHaveLength(2)
        for (const result of metrics.summary!.lanes) {
          expect(result.complete).toBe(true)
          expect(result.run).toBe('settled')
          expect(result.terminalCause).toBe('finished')
          expect(result.latestAnswer?.text).toBeTruthy()
          expect(result.latestAnswer!.seq).toBeLessThanOrEqual(metrics.cuts[result.side])
          expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
        }
        for (const lane of metrics.lanes) expect(lane.prepared).toEqual(round.prepared?.[lane.side])
        const publication = journal.find(
          (entry) => entry.fact.kind === 'coordinator' && entry.fact.prepared?.left,
        )
        expect(publication).toBeDefined()
        const beforeSource = await client.comparison.metrics({ id: created.id, atSeq: publication!.seq })
        expect(beforeSource.lanes.every((lane) => lane.prepared === null)).toBe(true)
        expect(metrics.lanes[1]?.prepared?.configuration.runtimeConfig === null).toBe(
          rightRuntime === 'native',
        )
        const headsBeforeList = created.lanes.map((lane) => f.opened.get(lane.sessionId)!.lastSeq)
        const listed = await client.comparison.list({ limit: 1 })
        expect(listed.items).toMatchObject([
          { id: created.id, phase: 'completed', roundCount: 1, inspectable: true },
        ])
        expect(created.lanes.map((lane) => f.opened.get(lane.sessionId)!.lastSeq)).toEqual(headsBeforeList)
        expect(listed.nextCursor).toBeNull()
        expect(metrics.cuts).toEqual(journal.at(-1)?.cuts)
        expect(metrics.lanes.map((lane) => lane.accounting.llm.attempts)).toEqual([1, 1])
        for (const lane of metrics.lanes) expect(lane.accounting.throughSeq).toBe(metrics.cuts[lane.side])
        for (const lane of metrics.lanes) {
          const detail = await client.comparison.priceDetails({
            id: created.id,
            side: lane.side,
            atSeq: firstPage.throughSeq,
            limit: 1,
          })
          expect(detail.sessionId).toBe(lane.sessionId)
          expect(detail.throughSeq).toBe(metrics.cuts[lane.side])
          expect(detail.evidenceComplete).toBe(true)
          expect(detail.entries).toHaveLength(1)
          expect(detail.entries[0]?.outcome).toBe('completed')
          let page = detail
          let observed = detail.entries.length
          while (!page.complete) {
            const prior = page.nextAfterSeq
            page = await client.comparison.priceDetails({
              id: created.id,
              side: lane.side,
              atSeq: firstPage.throughSeq,
              afterSeq: prior,
              limit: 1,
            })
            expect(page.entries[0]?.originSeq).toBeGreaterThan(prior)
            expect(page.throughSeq).toBe(detail.throughSeq)
            observed += page.entries.length
          }
          expect(observed).toBe(lane.accounting.llm.attempts + lane.accounting.jev.attempts)
          expect(page.nextAfterSeq).toBe(detail.throughSeq)
          expect(JSON.stringify(detail)).not.toContain('Answer once')
          await expect(
            client.comparison.priceDetails({
              id: created.id,
              side: lane.side,
              atSeq: firstPage.throughSeq,
              maxBytes: 2,
            }),
          ).rejects.toThrow()
        }
        const missingDetail = vi.spyOn(f.ledger, 'scan').mockResolvedValueOnce([])
        const limitedDetail = await client.comparison.priceDetails({
          id: created.id,
          side: 'left',
          atSeq: firstPage.throughSeq,
        })
        missingDetail.mockRestore()
        expect(limitedDetail.evidenceComplete).toBe(false)
        expect(limitedDetail.issues).toContain('incomplete_prefix')
        const missingPage = vi.spyOn(f.ledger, 'scan').mockResolvedValueOnce([])
        const incomplete = await client.comparison.metrics({ id: created.id, atSeq: firstPage.throughSeq })
        missingPage.mockRestore()
        expect(incomplete.lanes[0]?.accounting.state).toBe('unknown')
        expect(incomplete.lanes[0]?.accounting.issues).toContain('incomplete_reader')
        expect(incomplete.cuts).toEqual(metrics.cuts)
        for (const lane of created.lanes) {
          const session = f.opened.get(lane.sessionId)!
          const answers = await session.scan({ type: 'assistant/message', order: 'asc', limit: 100 })
          expect(answers).toHaveLength(1)
          const recovered = await inspectComparisonInput({
            sessionId: session.key,
            inputId: input.inputId,
            throughSeq: session.lastSeq,
            scan: (query) => session.scan(query),
          })
          const acceptance = round.acceptances.find((item) => item.side === lane.side)
          if (acceptance?.status !== 'accepted') throw new Error('Expected a durable accepted receipt')
          expect(recovered).toEqual({
            receipt: {
              status: 'accepted',
              seq: acceptance.seq,
            },
            state: { phase: 'idle', lastSeq: session.lastSeq, settled: true, terminalCause: 'finished' },
          })
        }
      } finally {
        gate.finish()
        await f.close()
      }
    },
  )

  it('binds storage and lane ownership to the established principal instead of the transport placeholder', async () => {
    const f = await fixture(new ScriptedProvider({ scripts: [say('unused')] }))
    try {
      const owner = f.connect('alice')
      const stranger = f.connect('bob')
      const params = {
        requestId: 'same-request',
        cwd: f.cwd,
        left: { runtime: 'native' },
        right: { runtime: 'native' },
      }
      const first = await owner.comparison.create(params)
      expect((await owner.comparison.list()).items.map((item) => item.id)).toEqual([first.id])
      expect(await stranger.comparison.list()).toEqual({ items: [], nextCursor: null })
      await expect(stranger.comparison.get(first.id)).rejects.toMatchObject({
        data: { code: 'COMPARISON_NOT_FOUND' },
      })
      await expect(stranger.comparison.journal({ id: first.id })).rejects.toThrow()
      await expect(stranger.comparison.metrics({ id: first.id, atSeq: 0 })).rejects.toThrow()
      await expect(
        stranger.comparison.priceDetails({ id: first.id, side: 'left', atSeq: 0 }),
      ).rejects.toThrow()
      const second = await stranger.comparison.create(params)
      expect(second.lanes.map((lane) => lane.sessionId)).not.toEqual(
        first.lanes.map((lane) => lane.sessionId),
      )
      expect((await owner.comparison.get(first.id)).lanes).toEqual(first.lanes)
      expect((await stranger.comparison.list()).items.map((item) => item.id)).toEqual([second.id])
    } finally {
      await f.close()
    }
  })

  it('cancels one live lane while its peer retains its running invocation', async () => {
    const gate = gatedProvider()
    const f = await fixture(gate.provider)
    try {
      const client = f.connect()
      const created = await client.comparison.create({
        requestId: 'cancel',
        cwd: f.cwd,
        left: { runtime: 'native' },
        right: { runtime: 'native' },
      })
      const round = await client.comparison.submit({
        id: created.id,
        inputId: 'one',
        content: [{ type: 'text', text: 'Hold for cancellation' }],
      })
      expect(round.acceptances.map((acceptance) => acceptance.status)).toEqual(['accepted', 'accepted'])
      await gate.started
      // Public stepping cannot borrow the capability of the currently running admitted input.
      for (const lane of created.lanes) {
        const session = f.opened.get(lane.sessionId)!
        await expect(session.step()).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
        await expect(
          session.setModel({ slot: 'primary', route: 'faux', model: 'faux-1' }),
        ).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
      }
      const unrelated = await client.comparison.cancel({ id: created.id, inputId: 'different-pending' })
      expect(unrelated.inputCancellations).toContainEqual({
        inputId: 'different-pending',
        states: [
          { side: 'left', status: 'acknowledged' },
          { side: 'right', status: 'acknowledged' },
        ],
      })
      expect(unrelated.rounds[0]?.settledSides).toEqual([])
      for (const lane of created.lanes) expect(gate.gates.get(lane.sessionId)?.signal.aborted).toBe(false)
      await client.comparison.cancel({ id: created.id, side: 'left' })
      expect(gate.gates.get(created.lanes[0]!.sessionId)?.signal.aborted).toBe(true)
      expect(gate.gates.get(created.lanes[1]!.sessionId)?.signal.aborted).toBe(false)
      gate.finish()
      await vi.waitFor(async () => {
        expect((await client.comparison.get(created.id)).rounds[0]?.settledSides).toEqual(['left', 'right'])
      })
      const final = await client.comparison.reconcile(created.id)
      expect(final.phase).toBe('partial')
      expect(final.rounds[0]?.terminalCauses).toEqual([
        { side: 'left', cause: 'cancelled' },
        { side: 'right', cause: 'finished' },
      ])
    } finally {
      gate.finish()
      await f.close()
    }
  })

  it.each([false, true])(
    'cancels durably admitted but unclaimed input and reconciles a lost acknowledgement=%s',
    async (lostAck) => {
      const f = await fixture(new ScriptedProvider({ scripts: [say('second left'), say('second right')] }))
      const normalCancel = f.host.configurationAdmissions.cancel.bind(f.host.configurationAdmissions)
      const cancelSpy = lostAck
        ? vi.spyOn(f.host.configurationAdmissions, 'cancel').mockImplementation(async (...args) => {
            await normalCancel(...args)
            throw new Error('cancel acknowledgement lost')
          })
        : undefined
      const admitted = deferred<void>()
      const release = deferred<void>()
      let count = 0
      f.hooks.afterEnqueue = async () => {
        if (++count === 2) admitted.resolve()
        await release.promise
      }
      try {
        const client = f.connect()
        const created = await client.comparison.create({
          requestId: 'unclaimed',
          cwd: f.cwd,
          left: { runtime: 'native' },
          right: { runtime: 'native' },
        })
        const first = client.comparison.submit({
          id: created.id,
          inputId: 'cancel-before-claim',
          content: [{ type: 'text', text: 'Never execute this input' }],
        })
        await admitted.promise
        const cancelling = client.comparison.cancel({ id: created.id })
        const storage = createComparisonStore(join(f.dataDir, 'comparisons', 'index.sqlite'))
        try {
          await vi.waitFor(async () => {
            expect((await storage.scoped('local').read(created.id))?.cancellation).toEqual({
              left: 'requested',
              right: 'requested',
            })
          })
        } finally {
          storage.close()
        }
        release.resolve()
        await first
        let cancelled = await cancelling
        if (lostAck) {
          expect(cancelled.inputCancellations?.[0]?.states).toEqual([
            { side: 'left', status: 'unknown' },
            { side: 'right', status: 'unknown' },
          ])
          cancelSpy?.mockRestore()
          cancelled = await f.connect().comparison.reconcile(created.id)
          expect(cancelled.inputCancellations?.[0]?.states).toEqual([
            { side: 'left', status: 'acknowledged' },
            { side: 'right', status: 'acknowledged' },
          ])
        }
        expect(cancelled.rounds[0]?.settledSides).toEqual(['left', 'right'])
        for (const session of f.opened.values()) expect(session.latest('inbox')).toMatchObject({ items: [] })
        delete f.hooks.afterEnqueue
        await client.comparison.submit({
          id: created.id,
          inputId: 'next-round',
          content: [{ type: 'text', text: 'Only this input may execute' }],
        })
        await vi.waitFor(async () => {
          expect((await client.comparison.get(created.id)).phase).toBe('completed')
        })
        for (const session of f.opened.values()) {
          const messages = await session.scan({ type: 'user/message', order: 'asc', limit: 100 })
          expect(JSON.stringify(messages)).not.toContain('Never execute this input')
          expect(JSON.stringify(messages)).toContain('Only this input may execute')
        }
      } finally {
        release.resolve()
        await f.close()
      }
    },
  )

  it('keeps a lost actual enqueue receipt unknown and dispatches neither configuration owner on retry', async () => {
    const f = await fixture(new ScriptedProvider({ scripts: [say('right only')] }))
    f.hooks.afterEnqueue = async (sessionId) => {
      if (sessionId.endsWith(':left')) throw new Error('simulated lost receipt after durable admission')
    }
    try {
      const client = f.connect()
      const created = await client.comparison.create({
        requestId: 'unknown',
        cwd: f.cwd,
        left: { runtime: 'native' },
        right: { runtime: 'native' },
      })
      const priorModes = new Map([...f.opened].map(([key, session]) => [key, session.d.approvalMode]))
      const input = {
        id: created.id,
        inputId: 'lost',
        permissionMode: 'full' as const,
        content: [{ type: 'text' as const, text: 'Admit once' }],
      }
      const submitted = await client.comparison.submit(input)
      expect(submitted.acceptances.map((item) => item.status)).toEqual(['unknown', 'accepted'])
      expect((await client.comparison.get(created.id)).rounds[0]?.settledSides).toEqual([])
      await client.comparison.submit(input)
      const left = f.opened.get(created.lanes[0]!.sessionId)!
      const inbox = left.latest('inbox') as { items: { commandId?: string }[] }
      expect(inbox.items.filter((item) => item.commandId === 'lost')).toHaveLength(1)
      expect(await left.scan({ type: 'user/message', limit: 100 })).toHaveLength(0)
      const right = f.opened.get(created.lanes[1]!.sessionId)!
      expect(await right.scan({ type: 'user/message', limit: 100 })).toHaveLength(0)
      expect(left.configurationReserved).toBe(true)
      expect(right.configurationReserved).toBe(true)
      for (const session of [left, right]) {
        expect(session.d.approvalMode).toBe('off')
        expect(session.yolo).toBe(false)
      }
      await expect(client.comparison.submit({ ...input, inputId: 'new' })).rejects.toMatchObject({
        data: {
          code: 'COMPARISON_BUSY',
          id: created.id,
          inputId: 'new',
          phase: 'pre-admission',
          inputAccepted: false,
        },
      })
      expect((await client.comparison.get(created.id)).rounds.map((round) => round.inputId)).toEqual(['lost'])
      // Explicit recovery may restore a lost admission receipt, but never re-enqueue or run it.
      await client.close()
      const reconnected = f.connect()
      expect((await reconnected.comparison.get(created.id)).rounds[0]?.acceptances[0]?.status).toBe('unknown')
      const recovered = await reconnected.comparison.reconcile(created.id)
      expect(recovered.rounds[0]?.acceptances.map((item) => item.status)).toEqual(['accepted', 'accepted'])
      expect(recovered.rounds[0]?.settledSides).toEqual([])
      expect(await f.ledger.scan(left.key, { type: 'user/message', limit: 100 })).toHaveLength(0)
      expect(f.opened.size).toBe(2)
      await expect(reconnected.comparison.submit({ ...input, inputId: 'still-busy' })).rejects.toThrow()
      const reopened = []
      for (const lane of created.lanes) {
        const original = f.opened.get(lane.sessionId)
        if (!original) throw new Error('Missing original lane')
        await reconnected.session.load(lane.sessionId, { cwd: original.d.cwd })
        const session = f.host.kernel.get(lane.sessionId)
        if (!session) throw new Error('Missing reopened owner')
        expect(session.configurationReserved).toBe(true)
        expect(session.d.approvalMode).toBe(priorModes.get(lane.sessionId))
        expect(session.yolo).toBe(false)
        await expect(session.step()).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
        reopened.push(session)
      }
      await reconnected.comparison.cancel({ id: created.id, inputId: input.inputId })
      for (const session of reopened) {
        expect(session.configurationReserved).toBe(false)
        expect(session.d.approvalMode).toBe(priorModes.get(session.key))
        expect(await session.scan({ type: 'user/message', limit: 100 })).toEqual([])
      }
    } finally {
      await f.close()
    }
  })

  it('drains both running sessions on local endpoint close and reads the durable comparison after reconnect', async () => {
    const gate = gatedProvider()
    const f = await fixture(gate.provider)
    try {
      const client = f.connect()
      const created = await client.comparison.create({
        requestId: 'disconnect',
        cwd: f.cwd,
        left: { runtime: 'native' },
        right: { runtime: 'native' },
      })
      const round = await client.comparison.submit({
        id: created.id,
        inputId: 'one',
        content: [{ type: 'text', text: 'Stop when endpoint closes' }],
      })
      expect(round.acceptances.map((item) => item.status)).toEqual(['accepted', 'accepted'])
      await gate.started
      await client.close()
      expect([...gate.gates.values()].every((value) => value.signal.aborted)).toBe(true)
      const reconnected = f.connect()
      expect((await reconnected.comparison.get(created.id)).rounds[0]?.acceptances).toEqual(round.acceptances)
      expect(gate.gates.size).toBe(2)
    } finally {
      gate.finish()
      await f.close()
    }
  })
})
