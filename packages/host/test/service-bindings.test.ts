import { Context } from '@agnes/cordis'
import {
  defineServiceKind,
  ProviderError,
  type ServiceInstance,
  type ServiceKind,
  type ServicePorts,
  type ServiceProvider,
  unavailableProjections,
} from '@agnes/extension-api'
import {
  GIT_WORKTREE_OWNER,
  GIT_WORKTREE_PACKAGE,
  GIT_WORKTREE_PROVIDER_ID,
  GIT_WORKTREE_PROVIDER_VERSION,
  gitWorktreeKind,
} from '@agnes/git-worktree-contract'
import { createOwnerLedger, type LedgerEvent } from '@agnes/host-common/assemble/owner-ledger'
import {
  ServiceBindings,
  type ServiceCall,
  type ServiceDescriptor,
  type ServicePortFactories,
  serviceBindingScope,
} from '@agnes/host-common/assemble/service-binding'
import type { GitWorktreeOperation } from '@agnes/host-infrastructure/git-worktrees'
import {
  createDeferredInvocationQueue,
  type DeferredInvocationLedgerPort,
  ownerDeferredQueue,
} from '@agnes/host-providers/assemble/deferred-invocations'
import {
  intelligentUiKind,
  type UiDataSourceProvider,
  uiDataSourceKind,
} from '@agnes/intelligent-ui-contract'
import { deferredProducerKind, deferredQueueKind } from '@agnes/plugin-runtime/deferred-contract'
import { type Actor, rpcError } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import {
  FEEDBACK_DESCRIPTOR,
  FEEDBACK_OWNER,
  FEEDBACK_PACKAGE_ID,
  FEEDBACK_PROVIDER_ID,
  type FeedbackAuthority,
  type FeedbackResult,
  feedbackKind,
} from '../src/runtime/feedback/contract.js'
import { createFeedbackLedger } from '../src/runtime/feedback/ledger.js'
import { createExtensionServiceHost, type ServiceAdmission } from '../src/runtime/services/author-port.js'
import { installGitWorktreeService } from '../src/runtime/services/git-worktrees.js'
import { type SessionLedgerSession, sessionInputTarget } from '../src/runtime/services/session-ports.js'

interface Probe extends ServiceInstance {
  mark(): string | Promise<string>
}

const owner = 'fixture/owner'
const otherOwner = 'fixture/beta'
const packageId = '@fixture/package'
const sessionRef = Object.freeze({ key: 'sess', lane: 'main', workspaceRoot: '/work' })

function defineKind(options: {
  kind?: string
  cardinality?: 'single' | 'multi'
  instanceScope?: 'request' | 'session' | 'workspace' | 'process'
  ports?: ServiceDescriptor['ports']
}) {
  return defineServiceKind<Probe, ServicePorts>({
    kind: options.kind ?? 'sample',
    cardinality: options.cardinality ?? 'single',
    instanceScope: options.instanceScope ?? 'request',
    ...(options.ports === undefined ? {} : { ports: options.ports }),
  })
}

function provider(
  id: string,
  open: ServiceProvider<Probe, ServicePorts>['open'],
): ServiceProvider<Probe, ServicePorts> {
  return { id, version: '1.0.0', open }
}

function call(
  input: {
    owner?: string
    packageId?: string
    signal?: AbortSignal
    live?: ServiceCall['live']
    session?: ServiceCall['session']
    generationId?: string
    watermark?: number
    actor?: Actor
    processKey?: string
    workspaceKey?: string
    providerId?: string
  } = {},
): ServiceCall {
  const admitted = input.owner ?? owner
  return {
    owner: admitted,
    packageId: input.packageId ?? packageId,
    signal: input.signal ?? new AbortController().signal,
    live:
      input.live ??
      (() => ({
        owner: admitted,
        active: true,
        ...(input.generationId === undefined ? {} : { generationId: input.generationId }),
      })),
    ...(input.session === undefined ? {} : { session: input.session }),
    ...(input.generationId === undefined ? {} : { generationId: input.generationId }),
    ...(input.watermark === undefined ? {} : { watermark: input.watermark }),
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    ...(input.processKey === undefined ? {} : { processKey: input.processKey }),
    ...(input.workspaceKey === undefined ? {} : { workspaceKey: input.workspaceKey }),
    ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
  }
}

async function mount(options: {
  descriptor: ServiceDescriptor
  kind?: ReturnType<typeof defineKind>
  entries: {
    id: string
    packageId: string
    owner?: string
    open: ServiceProvider<Probe, ServicePorts>['open']
  }[]
}) {
  const root = new Context()
  const kind = options.kind ?? defineKind({ ports: options.descriptor.ports })
  const bindings = new ServiceBindings(() => root.providers)
  bindings.install(root, kind, options.descriptor)
  for (const entry of options.entries) {
    const registered = provider(entry.id, entry.open)
    root.providers.register(kind, entry.packageId, registered)
    if (entry.owner)
      bindings.noteOwner(kind.kind, registered.id, registered.version, entry.owner, entry.packageId)
  }
  expect(root.providers.catalog().filter((item) => item.kind === kind.kind)).toHaveLength(
    options.entries.length,
  )
  return { root, kind, bindings }
}

async function finish(root: Context) {
  await root.fiber.dispose()
}

async function expectClosed(promise: Promise<unknown>, operation: string, kindName = 'sample') {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError)
    const providerError = error as ProviderError
    expect(providerError.code).toBe('E_PROVIDER_UNAVAILABLE')
    expect(providerError.kind).toBe(kindName)
    expect(providerError.operation).toBe(operation)
    expect(providerError.message).toContain('service binding is closed')
    expect(providerError.provider).toBeUndefined()
    return providerError
  }
  throw new Error(`expected ${operation} to close`)
}

const full = `x/${owner}/note`

function ledgerRow(seq: number, patch: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    seq,
    type: patch.type ?? full,
    data: patch.data ?? { seq },
    origin: patch.origin ?? `ext:${owner}`,
    trust: patch.trust ?? 'untrusted',
    ...(patch.lane === undefined ? { lane: 'main' } : { lane: patch.lane }),
  }
}

describe('service binding gate', () => {
  it('selects the sole candidate and refuses several unselected candidates', async () => {
    const opened: string[] = []
    const kind = defineKind({})
    const mounted = await mount({
      kind,
      descriptor: { ports: [], audience: 'host' },
      entries: ['one', 'two'].map((id) => ({
        id,
        packageId,
        open: () => {
          opened.push(id)
          return { mark: () => id }
        },
      })),
    })
    try {
      await expectClosed(mounted.bindings.bind(kind, call(), {}), 'bind')
      expect(opened).toEqual([])
      const scope = serviceBindingScope(kind, call())
      mounted.root.providers.select(kind.kind, { provider: 'two', version: '1.0.0' }, scope)
      const selected = await mounted.bindings.bind(kind, call(), {})
      expect(selected.mark()).toBe('two')
      expect(opened).toEqual(['two'])
      mounted.root.providers.configurationSource(() => [scope])
      await expectClosed(mounted.bindings.bind(kind, call(), {}), 'bind')
    } finally {
      await finish(mounted.root)
    }
  })

  it('accepts one unselected candidate for a host audience without an owner claim', async () => {
    let opens = 0
    const kind = defineKind({})
    const mounted = await mount({
      kind,
      descriptor: { ports: [], audience: 'host' },
      entries: [
        {
          id: 'one',
          packageId,
          open: () => {
            opens += 1
            return { mark: () => 'ok' }
          },
        },
      ],
    })
    try {
      expect((await mounted.bindings.bind(kind, call(), {})).mark()).toBe('ok')
      expect(opens).toBe(1)
      await expectClosed(mounted.bindings.bind(kind, call({ packageId: '@other/package' }), {}), 'bind')
      expect(opens).toBe(1)
    } finally {
      await finish(mounted.root)
    }
  })

  it('keeps the first descriptor when a later tree installs the same kind', async () => {
    const root = new Context()
    const later = new Context()
    const kind = defineKind({})
    const bindings = new ServiceBindings(() => root.providers)
    bindings.install(root, kind, { ports: [], audience: 'host' })
    bindings.install(later, kind, { ports: [], audience: 'callback' })
    root.providers.register(
      kind,
      packageId,
      provider('one', () => ({ mark: () => 'ok' })),
    )
    try {
      expect((await bindings.bind(kind, call(), {})).mark()).toBe('ok')
    } finally {
      await finish(root)
      await finish(later)
    }
  })

  it('refuses a different token, a wider grant, and a callback without its owner claim', async () => {
    const root = new Context()
    const kind = defineKind({})
    const bindings = new ServiceBindings(() => root.providers)
    expect(() => bindings.install(root, kind, { ports: ['ledger'] })).toThrow(/exceeds the kind grant/)
    bindings.install(root, kind, { ports: [], audience: 'callback' })
    const other = defineKind({})
    expect(() => bindings.install(root, other, { ports: [] })).toThrow(/does not match the installed kind/)
    root.providers.register(
      kind,
      packageId,
      provider('one', () => ({ mark: () => 'ok' })),
    )
    try {
      await expectClosed(bindings.bind(kind, call(), {}), 'bind')
      await expect(bindings.bind(other, call(), {})).rejects.toMatchObject({
        code: 'E_PROVIDER_INVALID',
        operation: 'bind',
      })
      bindings.noteOwner(kind.kind, 'one', '1.0.0', owner, packageId)
      expect(() => bindings.noteOwner(kind.kind, 'one', '1.0.0', otherOwner, packageId)).toThrow(
        ProviderError,
      )
      expect((await bindings.bind(kind, call(), {})).mark()).toBe('ok')
      const mismatch = await expectClosed(bindings.bind(kind, call({ owner: otherOwner }), {}), 'bind')
      expect(mismatch.message).not.toContain(owner)
      expect(mismatch.message).not.toContain(otherOwner)
    } finally {
      await finish(root)
    }
  })

  it('fails closed for a dead admission, a missing scope, and ctx.providers until a binder exists', async () => {
    const kind = defineKind({ instanceScope: 'session' })
    const processKind = defineKind({ kind: 'process-sample', instanceScope: 'process' })
    let opens = 0
    const mounted = await mount({
      kind,
      descriptor: { ports: [], audience: 'host' },
      entries: [
        {
          id: 'one',
          packageId,
          open: () => {
            opens += 1
            return { mark: () => 'ok' }
          },
        },
      ],
    })
    const processRoot = new Context()
    const processBindings = new ServiceBindings(() => processRoot.providers)
    processBindings.install(processRoot, processKind, { ports: [], audience: 'host' })
    try {
      const admitted = call({ session: sessionRef, generationId: 'g1' })
      expect((await mounted.bindings.bind(kind, admitted, {})).mark()).toBe('ok')
      const aborted = new AbortController()
      aborted.abort()
      await expectClosed(
        mounted.bindings.bind(
          kind,
          call({ session: sessionRef, generationId: 'g1', signal: aborted.signal }),
          {},
        ),
        'bind',
      )
      await expectClosed(
        mounted.bindings.bind(
          kind,
          call({
            session: sessionRef,
            generationId: 'g1',
            live: () => {
              throw new Error('gone')
            },
          }),
          {},
        ),
        'bind',
      )
      await expectClosed(mounted.bindings.bind(kind, call({ session: sessionRef }), {}), 'bind')
      await expectClosed(processBindings.bind(processKind, call(), {}), 'bind', 'process-sample')
      await expectClosed(
        processBindings.bind(processKind, call({ processKey: 'home\0root' }), {}),
        'bind',
        'process-sample',
      )
      expect(opens).toBe(1)
      expect(() => mounted.root.providers.bindOwn(kind)).toThrow(/service binding is closed/)
      const unknown = defineKind({ kind: 'missing-service' })
      expect(() => mounted.root.providers.bindOwn(unknown)).toThrow(/not registered/)
      let bound = 0
      mounted.root.providers.installServiceBinder(
        async <S extends ServiceInstance, P extends ServicePorts>(_kind: ServiceKind<S, P>) => {
          bound += 1
          return { mark: () => 'bound' } as unknown as S
        },
      )
      expect((await mounted.root.providers.bindOwn(kind)).mark()).toBe('bound')
      expect(bound).toBe(1)
    } finally {
      await finish(mounted.root)
      await finish(processRoot)
    }
  })

  it('pins the generation and disposes a late open when the admission ends', async () => {
    let generation = 'g1'
    let opens = 0
    let disposed = 0
    const kind = defineKind({ instanceScope: 'session' })
    const mounted = await mount({
      kind,
      descriptor: { ports: [], audience: 'host' },
      entries: [
        {
          id: 'one',
          packageId,
          open: () => {
            opens += 1
            return {
              mark: () => 'ok',
              dispose() {
                disposed += 1
              },
            }
          },
        },
      ],
    })
    const admitted = () =>
      call({
        session: sessionRef,
        generationId: generation,
        live: () => ({ owner, active: true, generationId: generation }),
      })
    try {
      const first = await mounted.bindings.bind(kind, admitted(), {})
      generation = 'g2'
      expect(() => first.mark()).toThrow(/service binding is closed/)
      const second = await mounted.bindings.bind(kind, admitted(), {})
      expect(second.mark()).toBe('ok')
      expect(opens).toBe(2)
      expect(first).not.toBe(second)
      let live = true
      const late = await mount({
        descriptor: { ports: [], audience: 'host' },
        entries: [
          {
            id: 'one',
            packageId,
            open: async () => {
              live = false
              return {
                mark: () => 'late',
                dispose() {
                  disposed += 1
                },
              }
            },
          },
        ],
      })
      try {
        await expectClosed(
          late.bindings.bind(
            late.kind,
            call({ live: () => (live ? { owner, active: true } : undefined) }),
            {},
          ),
          'bind',
        )
        expect(disposed).toBe(1)
      } finally {
        await finish(late.root)
      }
      live = true
      const failing = await mount({
        descriptor: { ports: [], audience: 'host' },
        entries: [
          {
            id: 'one',
            packageId,
            open: async () => {
              live = false
              return {
                mark: () => 'late',
                dispose() {
                  throw new Error('cleanup failed')
                },
              }
            },
          },
        ],
      })
      try {
        await expect(
          failing.bindings.bind(
            failing.kind,
            call({ live: () => (live ? { owner, active: true } : undefined) }),
            {},
          ),
        ).rejects.toMatchObject({
          code: 'E_PROVIDER_UNAVAILABLE',
          cause: expect.objectContaining({ message: 'cleanup failed' }),
        })
      } finally {
        await finish(failing.root)
      }
    } finally {
      await finish(mounted.root)
    }
  })

  it('fails a cached handle closed and disposes the underlying instance once', async () => {
    let active = true
    let disposed = 0
    let marks = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const mounted = await mount({
      descriptor: { ports: [], audience: 'host' },
      entries: [
        {
          id: 'one',
          packageId,
          open: () =>
            ({
              mark: () => {
                marks += 1
                return 'ok'
              },
              async late() {
                await gate
                return 'late'
              },
              dispose() {
                disposed += 1
              },
            }) as Probe,
        },
      ],
    })
    try {
      const instance = await mounted.bindings.bind(
        mounted.kind,
        call({ live: () => (active ? { owner, active: true } : undefined) }),
        {},
      )
      expect(instance.mark()).toBe('ok')
      const pending = (instance as Probe & { late(): Promise<string> }).late()
      active = false
      release()
      await expect(pending).rejects.toThrow(/service binding is closed/)
      expect(() => instance.mark()).toThrow(/service binding is closed/)
      expect(marks).toBe(1)
      active = true
      const dispose = instance.dispose
      if (!dispose) throw new Error('bound instance has no dispose')
      const first = dispose()
      expect(dispose()).toBe(first)
      await first
      expect(disposed).toBe(1)
      expect(() => instance.mark()).toThrow(/service binding is closed/)
      await dispose()
      expect(disposed).toBe(1)
    } finally {
      await finish(mounted.root)
    }
  })

  it('copies prototype methods, skips then, and omits ports the descriptor did not grant', async () => {
    class Box implements Probe {
      readonly label = 'kept'
      readonly authority = { allow: true }
      mark() {
        return 'proto'
      }
      // The facade must not copy `then`, or awaiting bind() would unwrap the instance.
      // biome-ignore lint/suspicious/noThenProperty: fixture proves then is skipped
      then() {
        return 'then'
      }
    }
    let built = 0
    let captured: ServicePorts | undefined
    const mounted = await mount({
      descriptor: { ports: [], audience: 'host' },
      entries: [
        {
          id: 'one',
          packageId,
          open: (ports) => {
            captured = ports
            return new Box()
          },
        },
      ],
    })
    const factories: ServicePortFactories = {
      ledger: () => {
        built += 1
        return {
          async scanOwn() {
            return { events: [], asOfSeq: 1 }
          },
          async appendOwn() {
            return 1
          },
        }
      },
    }
    try {
      const instance = await mounted.bindings.bind(mounted.kind, call(), factories)
      expect(instance.mark()).toBe('proto')
      expect((instance as Probe & { label?: string; authority?: unknown }).label).toBe('kept')
      expect((instance as Probe & { authority?: unknown }).authority).toBeUndefined()
      expect('then' in instance).toBe(false)
      expect(captured && 'ledger' in captured).toBe(false)
      expect(captured && 'lastSeq' in captured).toBe(false)
      expect(built).toBe(0)
      const granted = defineKind({ ports: ['ledger', 'input'] })
      const refused = await mount({
        kind: granted,
        descriptor: { ports: ['ledger', 'input'], audience: 'host', eventNames: ['note'] },
        entries: [{ id: 'one', packageId, open: () => ({ mark: () => 'no' }) }],
      })
      try {
        await expectClosed(
          refused.bindings.bind(granted, call({ watermark: 4, actor: extensionActor(owner) }), {}),
          'bind',
        )
      } finally {
        await finish(refused.root)
      }
    } finally {
      await finish(mounted.root)
    }
  })

  it('namespaces delivery keys and passes the existing exact keys through', async () => {
    const seen: { key: string; text: string }[] = []
    const input = () => ({
      deliver: (key: string, text: string) => {
        seen.push({ key, text })
        return Promise.resolve(7)
      },
    })
    const kind = defineKind({ ports: ['input'] })
    const exactKind = defineKind({ kind: 'exact-sample', ports: ['input'] })
    const captured: ServicePorts[] = []
    const open = (ports: ServicePorts) => {
      captured.push(ports)
      return { mark: () => 'ok' }
    }
    const namespaced = await mount({
      kind,
      descriptor: { ports: ['input'], audience: 'host', dedupeKeys: 'namespaced' },
      entries: [{ id: 'one', packageId, open }],
    })
    const exact = await mount({
      kind: exactKind,
      descriptor: { ports: ['input'], audience: 'host', dedupeKeys: 'exact' },
      entries: [{ id: 'one', packageId, open }],
    })
    const actor = extensionActor(owner)
    const refuse = (run: () => Promise<unknown>) => expectClosed(Promise.resolve().then(run), 'deliver')
    try {
      await namespaced.bindings.bind(kind, call({ actor }), { input })
      await exact.bindings.bind(exactKind, call({ actor }), { input })
      const namespacedInput = captured[0]?.input
      const exactInput = captured[1]?.input
      if (!namespacedInput || !exactInput) throw new Error('input port was not granted')
      const signal = new AbortController().signal
      await namespacedInput.deliver('ui-result:cmd-1', 'hello', signal)
      expect(seen.at(-1)).toEqual({ key: `svc/sample/${owner}/ui-result:cmd-1`, text: 'hello' })
      await namespacedInput.deliver('wake', '', signal)
      expect(seen.at(-1)).toEqual({ key: `svc/sample/${owner}/wake`, text: '' })
      const prefix = `svc/sample/${owner}/`
      await namespacedInput.deliver('k'.repeat(256 - prefix.length), 'x', signal)
      const before = seen.length
      await refuse(() => namespacedInput.deliver('k'.repeat(257 - prefix.length), 'x', signal))
      await refuse(() => namespacedInput.deliver('', 'x', signal))
      await refuse(() => namespacedInput.deliver('bad\0key', 'x', signal))
      await refuse(() => namespacedInput.deliver('x'.repeat(257), 'x', signal))
      await refuse(() => namespacedInput.deliver('ok', 1 as never, signal))
      const aborted = new AbortController()
      aborted.abort()
      await expect(
        Promise.resolve().then(() => namespacedInput.deliver('ok', 'x', aborted.signal)),
      ).rejects.toThrow()
      expect(seen).toHaveLength(before)
      await exactInput.deliver('ui-result:cmd-1', 'hello', signal)
      await exactInput.deliver('deferred-wake:job:4', 'again', signal)
      expect(seen.at(-2)).toEqual({ key: 'ui-result:cmd-1', text: 'hello' })
      expect(seen.at(-1)).toEqual({ key: 'deferred-wake:job:4', text: 'again' })
    } finally {
      await finish(namespaced.root)
      await finish(exact.root)
    }
  })
})

describe('owner ledger', () => {
  function sourceFor(rows: readonly LedgerEvent[], boundary = 0) {
    const appended: { type: string; data: unknown; sourceSeq?: number }[] = []
    const source = {
      boundarySeq: boundary,
      lane: 'main',
      alive() {},
      async *scan() {
        yield rows
      },
      async append(type: string, data: unknown, sourceSeq?: number) {
        appended.push(sourceSeq === undefined ? { type, data } : { type, data, sourceSeq })
        return 30
      },
    }
    return { source, appended }
  }

  it('returns only this owner’s untrusted events inside the watermark and ignores payload owner', async () => {
    const missingLane: LedgerEvent = {
      seq: 9,
      type: full,
      data: { seq: 9 },
      origin: `ext:${owner}`,
      trust: 'untrusted',
    }
    const rows = [
      ledgerRow(2),
      ledgerRow(3, { lane: 'other' }),
      ledgerRow(4, { origin: `ext:${otherOwner}` }),
      ledgerRow(5, { trust: 'trusted' }),
      ledgerRow(6, { trust: 'system' }),
      ledgerRow(7, { type: 'system/reserved' }),
      ledgerRow(8, { data: { owner: 'other/person' } }),
      missingLane,
      ledgerRow(10),
      ledgerRow(11),
    ]
    const { source } = sourceFor(rows, 2)
    const port = createOwnerLedger({ kind: 'sample', owner, eventNames: ['note'], watermark: 10, source })
    const page = await port.scanOwn({ names: ['note'], limit: 10 })
    expect(page.events.map((event) => event.seq)).toEqual([8, 10])
    expect(page.events[0]?.data).toEqual({ owner: 'other/person' })
    expect(page.asOfSeq).toBe(10)
  })

  it('pages with a cursor and refuses a cursor, watermark, or limit that does not match', async () => {
    const { source } = sourceFor([ledgerRow(4), ledgerRow(5), ledgerRow(6)])
    const port = createOwnerLedger({
      kind: 'sample',
      owner,
      eventNames: ['extra', 'note'],
      watermark: 10,
      source,
    })
    const first = await port.scanOwn({ names: ['note', 'extra'], limit: 2 })
    expect(first.events.map((event) => event.seq)).toEqual([4, 5])
    const second = await port.scanOwn({
      names: ['extra', 'note'],
      limit: 2,
      ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
    })
    expect(second.events.map((event) => event.seq)).toEqual([6])
    expect(second.nextCursor).toBeUndefined()
    const mixed = createOwnerLedger({
      kind: 'sample',
      owner,
      eventNames: ['note', 'extra'],
      watermark: 10,
      source: sourceFor([ledgerRow(4), ledgerRow(5, { type: `x/${owner}/extra` })]).source,
    })
    expect((await mixed.scanOwn({ names: ['note'], limit: 10 })).events.map((event) => event.seq)).toEqual([
      4,
    ])
    await expect(
      port.scanOwn({
        names: ['note'],
        limit: 2,
        ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
      }),
    ).rejects.toThrow(/cursor/)
    await expect(port.scanOwn({ names: ['note'], limit: 1, cursor: '%%%' })).rejects.toThrow(/cursor/)
    await expect(port.scanOwn({ names: ['note'], limit: 1, asOfSeq: 0 })).rejects.toThrow(/watermark/)
    await expect(port.scanOwn({ names: ['note'], limit: 1, asOfSeq: 11 })).rejects.toThrow(/watermark/)
    await expect(port.scanOwn({ names: ['note'], limit: 0 })).rejects.toThrow(/limit/)
    await expect(port.scanOwn({ names: ['note'], limit: 257 })).rejects.toThrow(/limit/)
    await expect(port.scanOwn({ names: ['note'], limit: 1.5 })).rejects.toThrow(/limit/)
    await expect(port.scanOwn({ names: [], limit: 1 })).rejects.toThrow(/undeclared/)
    await expect(port.scanOwn({ names: ['note', 'note'], limit: 1 })).rejects.toThrow(/undeclared/)
    await expect(port.scanOwn({ names: ['missing'], limit: 1 })).rejects.toThrow(/undeclared/)
  })

  it('rejects unordered pages, oversized payloads, and undeclared appends', async () => {
    const appended: { type: string; data: unknown; sourceSeq?: number }[] = []
    const port = createOwnerLedger({
      kind: 'sample',
      owner,
      eventNames: ['note'],
      watermark: 10,
      source: {
        boundarySeq: 0,
        lane: 'main',
        alive() {},
        async *scan() {
          yield [ledgerRow(4), ledgerRow(3)]
        },
        async append(type, data, sourceSeq) {
          appended.push(sourceSeq === undefined ? { type, data } : { type, data, sourceSeq })
          return 30
        },
      },
    })
    await expect(port.scanOwn({ names: ['note'], limit: 10 })).rejects.toThrow(/unordered/)
    const huge = createOwnerLedger({
      kind: 'sample',
      owner,
      eventNames: ['note'],
      watermark: 10,
      source: {
        boundarySeq: 0,
        lane: 'main',
        alive() {},
        async *scan() {
          yield [ledgerRow(4, { data: 'x'.repeat(262145) })]
        },
        async append() {
          return 1
        },
      },
    })
    await expect(huge.scanOwn({ names: ['note'], limit: 1 })).rejects.toThrow(/byte budget/)
    const chunk = 'x'.repeat(200_000)
    const paged = createOwnerLedger({
      kind: 'sample',
      owner,
      eventNames: ['note'],
      watermark: 10,
      source: {
        boundarySeq: 0,
        lane: 'main',
        alive() {},
        async *scan() {
          yield [ledgerRow(4, { data: chunk }), ledgerRow(5, { data: chunk })]
        },
        async append() {
          return 1
        },
      },
    })
    const page = await paged.scanOwn({ names: ['note'], limit: 10 })
    expect(page.events).toHaveLength(1)
    expect(page.nextCursor).toEqual(expect.any(String))
    await expect(port.appendOwn('missing', { ok: true })).rejects.toThrow(/undeclared/)
    await expect(port.appendOwn('note', 'x'.repeat(70_000))).rejects.toThrow(/JSON/)
    await expect(port.appendOwn('note', { ok: true }, 0)).rejects.toThrow(/source/)
    await expect(port.appendOwn('note', { ok: true }, 1.5)).rejects.toThrow(/source/)
    expect(appended).toEqual([])
    expect(await port.appendOwn('note', { ok: true }, 4)).toBe(30)
    expect(appended).toEqual([{ type: full, data: { ok: true }, sourceSeq: 4 }])
    expect(() =>
      createOwnerLedger({
        kind: 'sample',
        owner: 'not-an-owner',
        eventNames: ['note'],
        watermark: 1,
        source: {
          boundarySeq: 0,
          lane: 'main',
          alive() {},
          async *scan() {},
          async append() {
            return 1
          },
        },
      }),
    ).toThrow(/owner/)
  })

  it('reads an empty ledger and a row appended after the bind', async () => {
    const stored: LedgerEvent[] = []
    let seq = 0
    const port = createOwnerLedger({
      kind: 'sample',
      owner,
      eventNames: ['note'],
      watermark: 0,
      source: {
        boundarySeq: 0,
        lane: 'main',
        alive() {},
        async *scan(fromSeq, toSeq) {
          yield stored.filter((row) => row.seq >= fromSeq && row.seq <= toSeq)
        },
        async append(type, data) {
          const row = ledgerRow(++seq, { type, data })
          stored.push(row)
          return row.seq
        },
      },
    })
    await expect(port.scanOwn({ names: ['note'], limit: 10 })).resolves.toMatchObject({
      events: [],
      asOfSeq: 0,
    })
    await expect(port.appendOwn('note', { ok: true })).resolves.toBe(1)
    await expect(port.scanOwn({ names: ['note'], limit: 10 })).resolves.toMatchObject({
      events: [expect.objectContaining({ seq: 1 })],
    })
  })
})

function extensionActor(id: string): Actor {
  return { id, org: 'local', role: 'extension', deptPath: [], attrs: {} }
}

describe('session delivery target', () => {
  const base = {
    op: () => null as unknown,
    d: { loopFactory: { controls: { steer: true } } },
  }
  it('uses next-step only while a steered turn is open', () => {
    expect(sessionInputTarget(base, 'next-turn')).toBe('next-turn')
    expect(sessionInputTarget(base, 'follow-steer')).toBe('next-turn')
    expect(sessionInputTarget({ ...base, op: () => ({}) }, 'follow-steer')).toBe('next-step')
    expect(
      sessionInputTarget(
        { op: () => ({}), d: { loopFactory: { controls: { steer: false } } } },
        'follow-steer',
      ),
    ).toBe('next-turn')
    expect(sessionInputTarget({ op: () => ({}), d: { loopFactory: {} } }, 'follow-steer')).toBe('next-turn')
  })
})

describe('extension service host', () => {
  function sessionFixture() {
    const events: LedgerEvent[] = []
    const appended: {
      type: string
      data: unknown
      meta: { source: string; trust: string }
      sourceSeq?: number
    }[] = []
    const enqueued: { target: string; commandId: string; text: string; actor: Actor }[] = []
    let operation: unknown = null
    let steer = false
    let closing = false
    const session: SessionLedgerSession & { key: string } = {
      key: 'sess',
      lane: 'main',
      lastSeq: 10,
      get closingOrClosed() {
        return closing
      },
      d: {
        cwd: '/work',
        log: { parent: { boundarySeq: 2 } },
        loopFactory: {
          controls: {
            get steer() {
              return steer
            },
          },
        },
      },
      op: () => operation,
      async scan(query) {
        const asked = query as { fromSeq?: number; toSeq?: number; lane?: string; type?: string }
        if (asked.type === 'inbox') return []
        return events.filter((row) => {
          if (asked.fromSeq !== undefined && row.seq < asked.fromSeq) return false
          if (asked.toSeq !== undefined && row.seq > asked.toSeq) return false
          if (asked.lane !== undefined && row.lane !== asked.lane) return false
          return true
        })
      },
      async appendExtensionEvent(type, data, meta, sourceSeq) {
        appended.push(sourceSeq === undefined ? { type, data, meta } : { type, data, meta, sourceSeq })
        return 11
      },
      async enqueue(target, message) {
        enqueued.push({
          target,
          commandId: message.commandId,
          text: message.content[0]?.text ?? '',
          actor: message.actor,
        })
        return 12
      },
    }
    return {
      session,
      events,
      appended,
      enqueued,
      setOperation: (value: unknown) => {
        operation = value
      },
      setSteer: (value: boolean) => {
        steer = value
      },
      setClosing: (value: boolean) => {
        closing = value
      },
    }
  }

  it('stamps actor, exact keys, ledger facts, and the follow-steer target', async () => {
    const fixture = sessionFixture()
    const root = new Context()
    const state = {
      token: {} as object,
      owner,
      active: true,
      generation: 'g1',
      session: fixture.session,
    }
    const readAdmission = (): ServiceAdmission => ({
      token: state.token,
      owner: state.owner,
      active: state.active,
      signal: new AbortController().signal,
      session: state.session,
    })
    const host = createExtensionServiceHost({
      providers: () => root.providers,
      sessionGeneration: () => state.generation,
      readAdmission,
    })
    const kind = defineKind({ instanceScope: 'session', ports: ['ledger', 'input'] })
    host.install(root, kind, {
      ports: ['ledger', 'input'],
      audience: 'callback',
      dedupeKeys: 'exact',
      delivery: 'follow-steer',
      eventNames: ['note'],
    })
    let captured: ServicePorts | undefined
    let opens = 0
    host.ports.register(
      kind,
      {
        id: 'one',
        version: '1.0.0',
        open(ports) {
          opens += 1
          captured = ports
          return { mark: () => 'ok', dispose() {} }
        },
      },
      { owner, packageId },
    )
    const identity = {
      owner,
      packageId,
      trust: 'trusted' as const,
      projections: unavailableProjections,
      recheck() {},
    }
    try {
      const instance = await host.ports.bindOwn(kind, identity)
      expect(instance.mark()).toBe('ok')
      expect(opens).toBe(1)
      fixture.events.push(
        ledgerRow(2),
        ledgerRow(3, { data: { owner: 'other/person' } }),
        ledgerRow(4, { origin: `ext:${otherOwner}` }),
        ledgerRow(11),
      )
      const page = await captured?.ledger?.scanOwn({ names: ['note'], limit: 10 })
      expect(page?.events.map((event) => event.seq)).toEqual([3])
      expect(page?.events[0]?.data).toEqual({ owner: 'other/person' })
      expect(await captured?.ledger?.appendOwn('note', { ok: true }, 4)).toBe(11)
      expect(fixture.appended[0]).toMatchObject({
        type: full,
        data: { ok: true },
        sourceSeq: 4,
        meta: { source: owner, trust: 'trusted' },
      })
      const signal = new AbortController().signal
      await captured?.input?.deliver('ui-result:cmd-1', 'hello', signal)
      expect(fixture.enqueued[0]).toEqual({
        target: 'next-turn',
        commandId: 'ui-result:cmd-1',
        text: 'hello',
        actor: extensionActor(owner),
      })
      fixture.setOperation({})
      fixture.setSteer(true)
      await captured?.input?.deliver('deferred-wake:job:4', 'again', signal)
      expect(fixture.enqueued[1]).toMatchObject({
        target: 'next-step',
        commandId: 'deferred-wake:job:4',
        actor: extensionActor(owner),
      })
      const token = state.token
      fixture.setClosing(true)
      expect(() => instance.mark()).toThrow(/service binding is closed/)
      fixture.setClosing(false)
      state.active = false
      expect(() => instance.mark()).toThrow(/service binding is closed/)
      state.active = true
      state.token = {}
      expect(() => instance.mark()).toThrow(/service binding is closed/)
      state.token = token
      state.owner = otherOwner
      expect(() => instance.mark()).toThrow(/service binding is closed/)
      state.owner = owner
      state.generation = 'g2'
      expect(() => instance.mark()).toThrow(/service binding is closed/)
      const again = await host.ports.bindOwn(kind, identity)
      expect(opens).toBe(2)
      expect(again).not.toBe(instance)
      expect(() => host.ports.bindOwn(kind, { ...identity, owner: otherOwner })).toThrow(
        /service binding is closed/,
      )
      expect(opens).toBe(2)
      state.owner = otherOwner
      const cross = await expectClosed(host.ports.bindOwn(kind, { ...identity, owner: otherOwner }), 'bind')
      expect(cross.message).not.toContain(owner)
      expect(opens).toBe(2)
    } finally {
      await finish(root)
    }
  })

  it('prefixes namespaced keys and refuses ctx.providers.bindOwn when owner packages disagree', async () => {
    const fixture = sessionFixture()
    const root = new Context()
    const controller = new AbortController()
    const state = { token: {} as object, owner, active: true, generation: 'g1', session: fixture.session }
    const host = createExtensionServiceHost({
      providers: () => root.providers,
      sessionGeneration: () => state.generation,
      readAdmission: () => ({
        token: state.token,
        owner: state.owner,
        active: state.active,
        signal: controller.signal,
        session: state.session,
      }),
    })
    const kind = defineKind({ instanceScope: 'session', ports: ['input'] })
    host.install(root, kind, { ports: ['input'], audience: 'callback', delivery: 'next-turn' })
    let captured: ServicePorts | undefined
    const open = (ports: ServicePorts) => {
      captured = ports
      return { mark: () => 'ok' }
    }
    host.ports.register(kind, { id: 'one', version: '1.0.0', open }, { owner, packageId })
    host.ports.register(kind, { id: 'two', version: '1.0.0', open }, { owner, packageId: '@other/package' })
    host.attachBinder(root.providers)
    try {
      await host.ports.bindOwn(kind, {
        owner,
        packageId,
        trust: 'builtin',
        projections: unavailableProjections,
        recheck() {},
      })
      await captured?.input?.deliver('wake', 'text', controller.signal)
      expect(fixture.enqueued[0]?.commandId).toBe(`svc/sample/${owner}/wake`)
      expect(() => root.providers.bindOwn(kind)).toThrow(/service binding is closed/)
      expect(fixture.enqueued).toHaveLength(1)
    } finally {
      await finish(root)
    }
  })

  it('binds the bundled subagent git worktree and refuses every other registrar', async () => {
    const fixture = sessionFixture()
    const root = new Context()
    const seen: GitWorktreeOperation[] = []
    const signal = new AbortController().signal
    const request = { signal, timeoutMs: 1000 }
    const state = {
      token: {} as object,
      owner: GIT_WORKTREE_OWNER,
      active: true,
      generation: 'g1',
      session: fixture.session,
    }
    const host = createExtensionServiceHost({
      providers: () => root.providers,
      sessionGeneration: () => state.generation,
      readAdmission: () => ({
        token: state.token,
        owner: state.owner,
        active: state.active,
        signal,
        session: state.session,
      }),
    })
    // A live origin table with no row. Host registration must still succeed.
    installGitWorktreeService(
      host,
      root,
      { lookup: () => undefined },
      {
        async create(_cwd, operation) {
          seen.push(operation)
          return {
            id: 'abcd1234',
            root: '/work',
            path: '/work/.worktrees/agnes-abcd1234',
            branch: 'agnes/subagent-abcd1234',
          }
        },
        async list(operation) {
          seen.push(operation)
          return []
        },
        async finish(_path, operation) {
          seen.push(operation)
          return { action: 'removed' }
        },
      },
    )
    const identity = {
      owner: GIT_WORKTREE_OWNER,
      packageId: GIT_WORKTREE_PACKAGE,
      trust: 'builtin' as const,
      projections: unavailableProjections,
      recheck() {},
    }
    const forged = defineServiceKind<ServiceInstance, ServicePorts>({
      kind: 'git-worktree',
      cardinality: 'single',
      instanceScope: 'workspace',
      scope: 'workspace',
      ports: [],
    })
    const forgedProvider = {
      id: GIT_WORKTREE_PROVIDER_ID,
      version: GIT_WORKTREE_PROVIDER_VERSION,
      open() {
        throw new Error('forged open')
      },
    }
    try {
      const first = await host.ports.bindOwn(gitWorktreeKind, identity)
      await expect(first.create('/work', request)).resolves.toMatchObject({ id: 'abcd1234' })
      expect(seen[0]).toMatchObject({ sessionKey: 'sess', timeoutMs: 1000 })
      state.generation = 'g2'
      state.token = {}
      expect(() => first.create('/work', request)).toThrow(/service binding is closed/)
      expect(seen).toHaveLength(1)
      const second = await host.ports.bindOwn(gitWorktreeKind, identity)
      expect(second).not.toBe(first)
      await expect(second.list(request)).resolves.toEqual([])
      expect(seen).toHaveLength(2)
      expect(seen[1]?.sessionKey).toBe('sess')
      state.owner = 'agnes/other'
      await expectClosed(
        host.ports.bindOwn(gitWorktreeKind, {
          ...identity,
          owner: 'agnes/other',
          packageId: '@agnes/other',
        }),
        'bind',
        'git-worktree',
      )
      await expectClosed(
        Promise.resolve().then(() => host.ports.bindOwn(gitWorktreeKind, identity)),
        'bind',
        'git-worktree',
      )
      await expectClosed(
        Promise.resolve().then(() =>
          host.ports.register(gitWorktreeKind, forgedProvider, {
            owner: GIT_WORKTREE_OWNER,
            packageId: GIT_WORKTREE_PACKAGE,
          }),
        ),
        'register',
        'git-worktree',
      )
      await expectClosed(
        Promise.resolve().then(() =>
          host.registerOn(root, forged, forgedProvider, {
            owner: GIT_WORKTREE_OWNER,
            packageId: GIT_WORKTREE_PACKAGE,
          }),
        ),
        'register',
        'git-worktree',
      )
      await expectClosed(
        Promise.resolve().then(() =>
          host.registerOn(
            root,
            gitWorktreeKind,
            { ...forgedProvider, id: 'agnes/forged-worktree' },
            { owner: 'agnes/other', packageId: '@agnes/other' },
          ),
        ),
        'register',
        'git-worktree',
      )
      await expect(
        Promise.resolve().then(() =>
          host.registerOn(root, gitWorktreeKind, forgedProvider, {
            owner: GIT_WORKTREE_OWNER,
            packageId: GIT_WORKTREE_PACKAGE,
          }),
        ),
      ).rejects.toThrow(/duplicate git-worktree provider/)
      expect(seen).toHaveLength(2)
    } finally {
      await finish(root)
    }
  })
})

const feedbackResult: FeedbackResult = {
  items: [],
  growth: [],
  counts: { up: 0, down: 0, withdrawn: 0, withCandidate: 0 },
  truncated: false,
}

function feedbackCall(): ServiceCall {
  return call({ owner: FEEDBACK_OWNER, packageId: FEEDBACK_PACKAGE_ID, watermark: 0 })
}

describe('feedback service binding', () => {
  it('is a single request-scoped service whose code change is restart-required', () => {
    expect(feedbackKind.cardinality).toBe('single')
    expect(feedbackKind.instanceScope).toBe('request')
    expect(feedbackKind.scope).toBe('workspace')
    expect(feedbackKind.restartRequired).toBe(true)
    expect(feedbackKind.versioned).toBe(true)
    expect([...feedbackKind.ports]).toEqual(['ledger', 'input', 'projections'])
    expect([...FEEDBACK_DESCRIPTOR.ports]).toEqual(['ledger'])
    expect(FEEDBACK_DESCRIPTOR.audience).toBe('host')
    expect([...(FEEDBACK_DESCRIPTOR.eventNames ?? [])]).toEqual(['item', 'growth'])
    const first = feedbackCall()
    const second = call({
      owner: FEEDBACK_OWNER,
      packageId: FEEDBACK_PACKAGE_ID,
      watermark: 0,
      workspaceKey: 'other-profile',
    })
    expect(serviceBindingScope(feedbackKind, first)).toBe('binding:feedback:request')
    expect(serviceBindingScope(feedbackKind, second)).toBe(serviceBindingScope(feedbackKind, first))
  })

  it('selects the one host provider and refuses none, several, or the wrong package', async () => {
    const opened: string[] = []
    let seen: ServicePorts | undefined
    const root = new Context()
    const bindings = new ServiceBindings(() => root.providers)
    bindings.install(root, feedbackKind, FEEDBACK_DESCRIPTOR)
    const register = (id: string) => {
      root.providers.register(feedbackKind, FEEDBACK_PACKAGE_ID, {
        id,
        version: '1.0.0',
        open(ports) {
          opened.push(id)
          seen = ports
          return {
            async execute() {
              return feedbackResult
            },
          }
        },
      })
    }
    try {
      await expectClosed(bindings.bind(feedbackKind, feedbackCall(), {}), 'bind', 'feedback')
      register('agh.other')
      register(FEEDBACK_PROVIDER_ID)
      await expectClosed(
        bindings.bind(feedbackKind, feedbackCall(), {
          ledger: () => {
            throw new Error('unopened')
          },
        }),
        'bind',
        'feedback',
      )
      expect(opened).toEqual([])
      const catalog = root.providers.catalog().filter((item) => item.kind === 'feedback')
      expect(catalog.map((item) => item.id).sort()).toEqual(['agh.feedback', 'agh.other'])
      for (const item of catalog) {
        expect(item).toMatchObject({
          sourcePackage: FEEDBACK_PACKAGE_ID,
          restartRequired: true,
          scope: 'workspace',
        })
      }
    } finally {
      await finish(root)
    }

    const sole = new Context()
    const soleBindings = new ServiceBindings(() => sole.providers)
    soleBindings.install(sole, feedbackKind, FEEDBACK_DESCRIPTOR)
    sole.providers.register(feedbackKind, FEEDBACK_PACKAGE_ID, {
      id: FEEDBACK_PROVIDER_ID,
      version: '1.0.0',
      open(ports) {
        opened.push(FEEDBACK_PROVIDER_ID)
        seen = ports
        return {
          async execute() {
            return feedbackResult
          },
        }
      },
    })
    try {
      await expectClosed(
        soleBindings.bind(
          feedbackKind,
          call({ owner: FEEDBACK_OWNER, packageId: '@other/package', watermark: 0 }),
          {
            ledger: () => {
              throw new Error('unopened')
            },
          },
        ),
        'bind',
        'feedback',
      )
      expect(opened).toEqual([])
      const first = await soleBindings.bind(feedbackKind, feedbackCall(), {
        ledger: () => createFeedbackLedger(feedbackAuthority(), 's', extensionActor('human')),
      })
      const second = await soleBindings.bind(feedbackKind, feedbackCall(), {
        ledger: () => createFeedbackLedger(feedbackAuthority(), 's', extensionActor('human')),
      })
      expect(second).not.toBe(first)
      expect(opened).toEqual([FEEDBACK_PROVIDER_ID, FEEDBACK_PROVIDER_ID])
      expect(Object.keys(seen ?? {}).sort()).toEqual(['binding', 'lastSeq', 'ledger', 'now'])
      expect(seen?.input).toBeUndefined()
      expect(seen?.projections).toBeUndefined()
      expect(seen?.lastSeq).toBe(0)
      expect(seen?.binding.session).toBeUndefined()
      expect(seen?.binding.packageId).toBe(FEEDBACK_PACKAGE_ID)
    } finally {
      await finish(sole)
    }
  })

  it('refuses a forged ledger name and pins the admitted session and actor', async () => {
    const appended: { sessionId: string; type: string; data: unknown; actor: Actor }[] = []
    const actor = extensionActor('human')
    const authority = feedbackAuthority(async (sessionId, type, data, admitted) => {
      appended.push({ sessionId, type, data, actor: admitted })
      return appended.length
    })
    const root = new Context()
    const bindings = new ServiceBindings(() => root.providers)
    bindings.install(root, feedbackKind, FEEDBACK_DESCRIPTOR)
    let ledger: ServicePorts['ledger']
    root.providers.register(feedbackKind, FEEDBACK_PACKAGE_ID, {
      id: FEEDBACK_PROVIDER_ID,
      version: '1.0.0',
      open(ports) {
        ledger = ports.ledger
        return {
          async execute() {
            return feedbackResult
          },
        }
      },
    })
    try {
      await bindings.bind(feedbackKind, feedbackCall(), {
        ledger: () => createFeedbackLedger(authority, 's', actor),
      })
      await expect(ledger!.appendOwn('nope', { ok: true })).rejects.toMatchObject({
        data: { reason: 'FEEDBACK_APPEND_FORBIDDEN' },
      })
      await expect(ledger!.appendOwn('x/feedback/item', { ok: true })).rejects.toMatchObject({
        data: { reason: 'FEEDBACK_APPEND_FORBIDDEN' },
      })
      await expect(
        createFeedbackLedger(authority, undefined, actor).appendOwn('item', { ok: true }),
      ).rejects.toMatchObject({
        data: { reason: 'FEEDBACK_APPEND_FORBIDDEN' },
      })
      expect(appended).toEqual([])
      expect(await ledger!.appendOwn('item', { actor: 'forged', sessionId: 'foreign' })).toBe(1)
      expect(appended).toEqual([
        {
          sessionId: 's',
          type: 'x/feedback/item',
          data: { actor: 'forged', sessionId: 'foreign' },
          actor,
        },
      ])
    } finally {
      await finish(root)
    }
  })
})

describe('ui data source bind by id', () => {
  it('refuses providerId on a single kind that would otherwise open', async () => {
    let opens = 0
    const kind = defineKind({})
    const mounted = await mount({
      kind,
      descriptor: { ports: [], audience: 'host' },
      entries: [
        {
          id: 'one',
          packageId,
          open: () => {
            opens += 1
            return { mark: () => 'ok' }
          },
        },
      ],
    })
    try {
      await expectClosed(mounted.bindings.bind(kind, call({ providerId: 'one' }), {}), 'bind')
      expect(opens).toBe(0)
      expect((await mounted.bindings.bind(kind, call(), {})).mark()).toBe('ok')
      expect(opens).toBe(1)
    } finally {
      await finish(mounted.root)
    }
  })

  it('opens the named multi provider without select and refuses a missing or foreign id', async () => {
    const opened: string[] = []
    const kind = defineKind({ cardinality: 'multi' })
    const mounted = await mount({
      kind,
      descriptor: { ports: [], audience: 'host' },
      entries: ['finance/differences', 'finance/balances'].map((id) => ({
        id,
        packageId,
        open: () => {
          opened.push(id)
          return { mark: () => id }
        },
      })),
    })
    try {
      await expectClosed(mounted.bindings.bind(kind, call(), {}), 'bind')
      await expectClosed(mounted.bindings.bind(kind, call({ providerId: '' }), {}), 'bind')
      await expectClosed(mounted.bindings.bind(kind, call({ providerId: 'missing/source' }), {}), 'bind')
      await expectClosed(
        mounted.bindings.bind(
          kind,
          call({ providerId: 'finance/differences', packageId: '@other/package' }),
          {},
        ),
        'bind',
      )
      expect(opened).toEqual([])
      const bound = await mounted.bindings.bind(kind, call({ providerId: 'finance/differences' }), {})
      expect(bound.mark()).toBe('finance/differences')
      expect(opened).toEqual(['finance/differences'])
    } finally {
      await finish(mounted.root)
    }
  })

  it('rejects a bad data-source registration and accepts a closed finance source', async () => {
    expect(uiDataSourceKind.cardinality).toBe('multi')
    expect(uiDataSourceKind.instanceScope).toBe('request')
    expect(uiDataSourceKind.scope).toBe('generation')
    expect([...uiDataSourceKind.ports]).toEqual([])
    expect(uiDataSourceKind.restartRequired).toBe(false)
    const root = new Context()
    const bindings = new ServiceBindings(() => root.providers)
    bindings.install(root, uiDataSourceKind, { ports: [], audience: 'host' })
    const source = (patch: Partial<UiDataSourceProvider> = {}): UiDataSourceProvider =>
      ({
        id: 'finance/differences',
        version: '1.0.0',
        paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
        result: 'rows',
        permission: 'finance.differences.read',
        capabilities: ['refresh'],
        open: () => ({ query: async () => [] }),
        ...patch,
      }) as UiDataSourceProvider
    const expectInvalid = (provider: UiDataSourceProvider, detail: string) => {
      try {
        root.providers.register(uiDataSourceKind, packageId, provider)
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError)
        const providerError = error as ProviderError
        expect(providerError.code).toBe('E_PROVIDER_INVALID')
        expect(providerError.kind).toBe('ui-data-source')
        expect(providerError.operation).toBe('register')
        expect(providerError.message).toContain(detail)
        return
      }
      throw new Error(`expected registration to reject ${detail}`)
    }
    expectInvalid(source({ id: 'Finance/differences' }), 'ui data source id is invalid')
    expectInvalid(
      source({ paramsSchema: { type: 'object', additionalProperties: true } as never }),
      'additionalProperties to false',
    )
    expectInvalid(source({ result: 'table' as never }), 'ui data source result is invalid')
    expectInvalid(source({ permission: 'read' }), 'ui data source permission is invalid')
    expectInvalid(
      source({ capabilities: ['refresh', 'admin'] as never }),
      'ui data source capabilities are invalid',
    )
    try {
      root.providers.register(uiDataSourceKind, packageId, source())
      expect(root.providers.catalog().map((entry) => entry.id)).toEqual(['finance/differences'])
    } finally {
      await finish(root)
    }
  })
})

describe('intelligent UI service binding', () => {
  const uiOwner = 'agnes/intelligent-ui'
  const uiPackage = '@agnes/base'

  it('keeps an owner claim until every registration of that provider is released', () => {
    const bindings = new ServiceBindings(() => {
      throw new Error('catalog unused')
    })
    bindings.noteOwner('sample', 'one', '1.0.0', owner, packageId)
    bindings.noteOwner('sample', 'one', '1.0.0', owner, packageId)
    bindings.forget('sample', 'one', '1.0.0')
    expect(bindings.claimPackage('sample', owner)).toBe(packageId)
    bindings.forget('sample', 'one', '1.0.0')
    expect(bindings.claimPackage('sample', owner)).toBeUndefined()
    bindings.noteOwner('sample', 'one', '1.0.0', owner, packageId)
    expect(() => bindings.noteOwner('sample', 'one', '1.0.0', otherOwner, packageId)).toThrow(ProviderError)
  })

  it('keeps an exact result key, guards capabilities, and fails closed without the owner', async () => {
    const root = new Context()
    const bindings = new ServiceBindings(() => root.providers)
    const delivered: string[] = []
    let task: (() => string) | undefined
    bindings.install(root, intelligentUiKind, {
      ports: ['ledger', 'input', 'projections'],
      eventNames: ['surface.opened'],
      projectionNames: ['surfaces'],
      audience: 'callback',
      delivery: 'follow-steer',
      dedupeKeys: 'exact',
      capabilities: () => ({ task: () => 'pinned' }),
      input: () => ({
        async deliver(key) {
          delivered.push(key)
          return 7
        },
      }),
    })
    expect(bindings.grants(intelligentUiKind.kind)).toEqual({
      events: true,
      projections: ['surfaces'],
    })
    root.providers.register(intelligentUiKind, uiPackage, {
      id: 'agnes/intelligent-ui',
      version: '0.1.0',
      open(ports) {
        task = (ports as { capabilities?: { task?: () => string } }).capabilities?.task
        return {
          async mark() {
            await ports.input!.deliver('ui-result:cmd-1', 'result', new AbortController().signal)
            return 'ok'
          },
        } as never
      },
    })
    const admitted = call({
      owner: uiOwner,
      packageId: uiPackage,
      session: sessionRef,
      generationId: 'gen-1',
      watermark: 1,
      actor: extensionActor(uiOwner),
    })
    const factories = {
      ledger: () =>
        createOwnerLedger({
          kind: intelligentUiKind.kind,
          owner: uiOwner,
          eventNames: ['surface.opened'],
          watermark: 1,
          source: {
            boundarySeq: 0,
            lane: 'main',
            alive() {},
            async *scan() {},
            async append() {
              return 1
            },
          },
        }),
      projections: unavailableProjections,
    }
    try {
      await expectClosed(bindings.bind(intelligentUiKind, admitted, factories), 'bind', 'intelligent-ui')
      bindings.noteOwner(intelligentUiKind.kind, 'agnes/intelligent-ui', '0.1.0', uiOwner, uiPackage)
      const ui = await bindings.bind(intelligentUiKind, admitted, factories)
      expect(task?.()).toBe('pinned')
      expect(await (ui as typeof ui & { mark(): Promise<string> }).mark()).toBe('ok')
      expect(delivered).toEqual(['ui-result:cmd-1'])
      await ui.dispose?.()
      expect(() => task?.()).toThrow(ProviderError)
      await expectClosed(
        bindings.bind(
          intelligentUiKind,
          call({
            owner: otherOwner,
            packageId: uiPackage,
            session: sessionRef,
            generationId: 'gen-1',
            watermark: 1,
            actor: extensionActor(otherOwner),
          }),
          factories,
        ),
        'bind',
        'intelligent-ui',
      )
    } finally {
      await finish(root)
    }
  })
})

describe('deferred invocation service binding', () => {
  it('opens each owner separately and hides the other owner receipt', async () => {
    const root = new Context()
    const bindings = new ServiceBindings(() => root.providers)
    bindings.install(root, deferredProducerKind, { ports: [], audience: 'callback' })
    bindings.install(root, deferredQueueKind, { ports: [], audience: 'host' })
    const seen: string[] = []
    const register = (id: string, sourcePackage: string, name: string) => {
      root.providers.register(deferredProducerKind, sourcePackage, {
        id,
        version: '1.0.0',
        open: () => ({
          async validate() {
            seen.push(name)
          },
          async changed() {
            seen.push(`${name}-changed`)
          },
        }),
      })
      bindings.noteOwner(
        deferredProducerKind.kind,
        id,
        '1.0.0',
        name === 'alpha' ? owner : otherOwner,
        sourcePackage,
      )
    }
    register('producer-alpha', packageId, 'alpha')
    register('producer-beta', '@fixture/beta', 'beta')
    const admitted = (who: string, sourcePackage: string, providerId?: string) =>
      call({
        owner: who,
        packageId: sourcePackage,
        session: sessionRef,
        generationId: 'gen-1',
        actor: extensionActor(who),
        ...(providerId === undefined ? {} : { providerId }),
      })
    const rows: { seq: number; type: string; data: unknown; origin: string; trust: string; lane: string }[] =
      []
    let seq = 0
    const ports: DeferredInvocationLedgerPort = {
      scan: async () => rows as never,
      append: async (type, data, by) => {
        seq += 1
        rows.push({ seq, type, data, origin: 'system', trust: 'trusted', lane: 'main', actor: by } as never)
        return seq
      },
      outcome: async () => ({}),
      wake: async () => undefined,
    }
    try {
      await expectClosed(
        bindings.bind(deferredQueueKind, admitted(owner, packageId), { now: () => 1 }),
        'bind',
        'deferred-invocations',
      )
      const alpha = await bindings.bind(deferredProducerKind, admitted(owner, packageId, 'producer-alpha'), {
        now: () => 1,
      })
      const beta = await bindings.bind(
        deferredProducerKind,
        admitted(otherOwner, '@fixture/beta', 'producer-beta'),
        { now: () => 1 },
      )
      await expectClosed(
        bindings.bind(deferredProducerKind, admitted(otherOwner, packageId, 'producer-alpha'), {
          now: () => 1,
        }),
        'bind',
        'deferred-producer',
      )
      const raw = createDeferredInvocationQueue('sess', 'main', ports, async (source, producerSignal) => {
        const instance = source === owner ? alpha : source === otherOwner ? beta : undefined
        if (!instance) return undefined
        return {
          source,
          validate: (invocation, admittedSignal) => instance.validate(invocation, admittedSignal),
          changed: (receipt, admittedSignal) => instance.changed(receipt, admittedSignal),
        }
      })
      const alphaQueue = ownerDeferredQueue(raw, {
        owner,
        actor: extensionActor(owner),
        confirmSource: async (sourceSeq, source) => {
          if (source !== owner || sourceSeq !== 1)
            throw new Error('Deferred invocation source event is missing')
        },
      })
      const betaQueue = ownerDeferredQueue(raw, {
        owner: otherOwner,
        actor: extensionActor(otherOwner),
        confirmSource: async () => undefined,
      })
      const invocation = {
        id: 'deferred:conformance',
        sessionKey: 'sess',
        lane: 'main',
        source: owner,
        sourceSeq: 1,
        actor: extensionActor(owner),
        tool: 'business_adjust',
        args: { cents: 1 },
      }
      const receipt = await alphaQueue.enqueue(invocation, new AbortController().signal)
      expect(seen).toEqual(['alpha'])
      await expect(betaQueue.read(receipt.invocation.id, new AbortController().signal)).rejects.toThrow(
        'another producer',
      )
      await expect(betaQueue.transition(receipt.invocation.id, receipt.seq, 'executing')).rejects.toThrow(
        'another producer',
      )
      expect(await raw.read(receipt.invocation.id, new AbortController().signal)).toMatchObject({
        state: 'queued',
        seq: receipt.seq,
      })
      await alpha.dispose?.()
      await beta.dispose?.()
      await expect(raw.notify(new AbortController().signal)).rejects.toThrow(/closed|unavailable/)
    } finally {
      await finish(root)
    }
  })
})

function feedbackAuthority(
  append: FeedbackAuthority['append'] = async () => {
    throw rpcError('CAPABILITY_DENIED', { reason: 'FEEDBACK_APPEND_FORBIDDEN' })
  },
): FeedbackAuthority {
  return {
    sessions: async () => ({ ids: ['s'], truncated: false }),
    scan: async () => [],
    append,
    draft: async () => [],
    recoverCandidate: async () => null,
    candidate: async () => {
      throw new Error('candidate')
    },
    evidence: async () => {
      throw new Error('evidence')
    },
    now: () => '2026-10-09T00:00:00Z',
    id: () => 'feedback-1',
  }
}
