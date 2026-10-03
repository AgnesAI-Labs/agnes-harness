import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pid } from 'node:process'
import { isDeepStrictEqual } from 'node:util'
import type {
  RendererDefinition,
  RendererHandle,
  UIRegistry,
  UIRegistryFactory,
  UIRegistryHost,
} from '@agnes/extension-api/client'
import type { Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { type BuildIdentity, type ReuseLifecycle, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { AssertionInput, ConformanceHarness } from '../harness.js'

const CONTRACT = 'agh.ui-registry'
const HEX = /^[a-f0-9]{64}$/
const TYPE = 'acme.card/view@1'
const DIGEST = 'c'.repeat(64)

/**
 * A binding supplies the registry factory and runs it in client processes. Each scenario builds its own
 * recording host, drives the registry and judges what it sees here, so every implementation is judged
 * the same way.
 */
export interface UIRegistryConformanceBinding {
  readonly providerId: string
  readonly recipe: string
  readonly command: string
  readonly build: BuildIdentity
  /** Hex digests of the registry code, its options and the release set it ships in. */
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
  readonly factory: UIRegistryFactory
  /**
   * Runs `recoverUIRegistry` with this registry in a client process over `directory` and kills it with
   * SIGKILL once it is ready, then runs it in a second process over the same directory until that one
   * exits. Resolves to each process's exit signal and pid, in that order.
   */
  restart(directory: string): Promise<readonly { signal: string | null; pid: number | null }[]>
}

type Request = Parameters<UIRegistry['resolve']>[0]
type Resolved = ReturnType<UIRegistry['resolve']>

/**
 * A double for the client host: records every bind with its definition object, refuses the next binds
 * when told to and accepts only the handles it issued. Handle ids carry a generation of their own, so a
 * host in another process never takes an old handle for one of its own.
 */
interface RecordingHost extends UIRegistryHost {
  readonly binds: RendererDefinition[]
  readonly handles: RendererHandle[]
  refuseNext(error: Wire.RuntimeError): void
  accepts(handleId: string | null): boolean
}

const DENIED: Wire.RuntimeError = {
  code: 'denied',
  detailCode: 'renderer_denied',
  message: 'the host refused this renderer',
  retryAdvice: { kind: 'never' },
  diagnosticId: 'ui-registry-conformance',
}

const unpresented = (): Outcome<never> => ({ ok: false, error: { ...DENIED, detailCode: 'not_presented' } })

function recordingHost(): RecordingHost {
  const generation = randomUUID()
  const refusals: Wire.RuntimeError[] = []
  const host: RecordingHost = {
    binds: [],
    handles: [],
    refuseNext: (error) => {
      refusals.push(error)
    },
    accepts: (handleId) => host.handles.some((handle) => handle.id === handleId),
    bindRenderer(definition) {
      host.binds.push(definition)
      const error = refusals.shift()
      if (error !== undefined) return { ok: false, error }
      const n = host.handles.length + 1
      const handle: RendererHandle = {
        id: `${generation}/handle-${n}`,
        ownerToken: `${generation}/owner-${n}`,
        present: unpresented,
        dispose: async () => {},
      }
      host.handles.push(handle)
      return { ok: true, value: handle }
    },
  }
  return host
}

const range = (minRevision: number, maxRevision: number) => ({ typeId: TYPE, minRevision, maxRevision })

function card(overrides: Partial<Wire.RendererDescriptor> = {}): Wire.RendererDescriptor {
  return {
    id: 'acme.card',
    packageDigest: DIGEST,
    renderKey: 'card',
    targets: ['web'],
    viewSchemaRanges: [range(1, 3)],
    requiredFeatures: [],
    optionalFeatures: [],
    scope: 'view',
    entry: './card.js',
    ...overrides,
  }
}

const web = (descriptor: Wire.RendererDescriptor): RendererDefinition => ({
  descriptor,
  component: () => null,
})
const text = (descriptor: Wire.RendererDescriptor): RendererDefinition => ({
  descriptor,
  format: unpresented,
})
const im = (descriptor: Wire.RendererDescriptor): RendererDefinition => ({
  descriptor,
  format: unpresented,
  encode: unpresented,
})

const ask = (
  renderKey: string,
  target: Request['target'],
  revision: number,
  requiredFeatures: string[] = [],
): Request => ({
  renderKey,
  viewSchema: { typeId: TYPE, revision, digest: DIGEST },
  target,
  requiredFeatures,
})

const code = (outcome: Outcome<unknown>) => (outcome.ok ? 'ok' : outcome.error.code)

/** `matched`, `fallback` when it carries a reason, or the refusal code. */
function kind(outcome: Resolved): string {
  if (!outcome.ok) return outcome.error.code
  if (outcome.value.kind === 'fallback') return outcome.value.reason ? 'fallback' : 'fallback without reason'
  return outcome.value.kind
}

/** Matched with the handle the host issued last, bound for `definition` itself. */
const leased = (outcome: Resolved, host: RecordingHost, definition: RendererDefinition) =>
  outcome.ok &&
  outcome.value.kind === 'matched' &&
  outcome.value.handle === host.handles.at(-1) &&
  host.binds.at(-1) === definition

function open(factory: UIRegistryFactory): { host: RecordingHost; registry: UIRegistry } {
  const host = recordingHost()
  const made = factory(host)
  if (!made.ok) throw new Error(`factory refused a recording host: ${made.error.code}`)
  return { host, registry: made.value }
}

function accepted<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(`refused: ${outcome.error.code}`)
  return outcome.value
}

/**
 * The Profile's text renderers, by descriptor id: two revision ranges of one card for the terminal and
 * one for the SDK. None conflicts with another, so their order cannot decide the selection.
 */
const TEXT_RENDERERS: Readonly<Record<string, RendererDefinition>> = Object.fromEntries(
  [
    card({ id: 'acme.card-tui-1', targets: ['tui'], viewSchemaRanges: [range(1, 2)] }),
    card({ id: 'acme.card-tui-3', targets: ['tui'], viewSchemaRanges: [range(3, 4)] }),
    card({ id: 'acme.card-sdk', targets: ['sdk'] }),
  ].map((descriptor) => [descriptor.id, text(descriptor)]),
)
const PROFILE = 'profile.json'
const KILLED = 'killed.json'
const REBUILT = 'rebuilt.json'

/** What a client process saw once it resolved. */
interface Selection {
  readonly pid: number
  readonly selected: string | null
  readonly handle: string | null
  /** Whether the handle is the one its host just bound for the selected renderer's definition. */
  readonly leased: boolean
  /** Rebuilt process only: whether its host refused the handle the killed process leased. */
  readonly oldHandleRefused?: boolean
}

/**
 * The client process side of `recover`, on the terminal (`tui`) text path only; a browser reload is
 * not covered. Reads the Profile in `directory`, builds a registry with `factory` over a recording host,
 * registers the Profile's text renderers and resolves one terminal view. The first process records what
 * it selected and calls `ready`, which must not return, since the process is killed there. A process
 * that finds that record is the rebuilt one: it registers the renderers in reverse order, as a restart
 * does not promise the order, resolves again and records whether its host refuses the old handle.
 */
export function recoverUIRegistry(factory: UIRegistryFactory, directory: string, ready: () => void): void {
  const profile = JSON.parse(readFileSync(join(directory, PROFILE), 'utf8')) as { renderers: string[] }
  const killed = join(directory, KILLED)
  const rebuilt = existsSync(killed)
  const { host, registry } = open(factory)
  for (const id of rebuilt ? [...profile.renderers].reverse() : profile.renderers) {
    const definition = TEXT_RENDERERS[id]
    if (definition === undefined) throw new Error(`the Profile names an unknown renderer: ${id}`)
    accepted(registry.register(definition))
  }
  const resolved = registry.resolve(ask('card', 'tui', 3))
  const matched = resolved.ok && resolved.value.kind === 'matched' ? resolved.value : null
  const definition = matched && TEXT_RENDERERS[matched.descriptor.id]
  const seen: Selection = {
    pid,
    selected: matched?.descriptor.id ?? null,
    handle: matched?.handle.id ?? null,
    leased: definition ? leased(resolved, host, definition) : false,
  }
  if (!rebuilt) {
    writeFileSync(killed, JSON.stringify(seen))
    ready()
    return
  }
  const old = (JSON.parse(readFileSync(killed, 'utf8')) as Selection).handle
  writeFileSync(join(directory, REBUILT), JSON.stringify({ ...seen, oldHandleRefused: !host.accepts(old) }))
}

const CASES: Record<ScenarioName, (binding: UIRegistryConformanceBinding) => Promise<boolean>> = {
  async select({ factory }) {
    const { host, registry } = open(factory)
    const definition = web(card())
    accepted(registry.register(definition))
    const resolved = registry.resolve(ask('card', 'web', 2))
    const descriptor = resolved.ok && resolved.value.kind === 'matched' ? resolved.value.descriptor : null
    return (
      leased(resolved, host, definition) && host.binds.length === 1 && isDeepStrictEqual(descriptor, card())
    )
  },

  async normal({ factory }) {
    const { host, registry } = open(factory)
    const page = web(card({ requiredFeatures: ['links'], optionalFeatures: ['compact'] }))
    const plain = text(card({ id: 'acme.card-text', targets: ['tui'] }))
    const chat = im(card({ id: 'acme.card-im', targets: ['im'] }))
    const registered = [page, plain, chat].map((definition) => code(registry.register(definition)))
    const served: readonly [RendererDefinition, Request][] = [
      [page, ask('card', 'web', 1, ['links'])],
      [plain, ask('card', 'tui', 2)],
      [chat, ask('card', 'im', 3)],
      [page, ask('card', 'web', 2, ['compact'])],
    ]
    const matched = served.every(([definition, request]) =>
      leased(registry.resolve(request), host, definition),
    )
    const fallbacks = [
      ask('table', 'web', 2),
      ask('card', 'sdk', 2),
      ask('card', 'web', 4),
      { ...ask('card', 'web', 2), viewSchema: { typeId: 'acme.table/view@1', revision: 2, digest: DIGEST } },
      ask('card', 'web', 2, ['charts']),
    ].map((request) => kind(registry.resolve(request)))
    return (
      isDeepStrictEqual(registered, ['ok', 'ok', 'ok']) &&
      matched &&
      fallbacks.every((seen) => seen === 'fallback')
    )
  },

  async deny({ factory }) {
    const { host, registry } = open(factory)
    const first = web(card())
    accepted(registry.register(first))
    const later = web(card({ id: 'acme.card-later', viewSchemaRanges: [range(4, 6)] }))
    const refusals = [
      code(factory({} as UIRegistryHost)),
      // Same cell: revisions 2 to 3 overlap.
      code(registry.register(web(card({ id: 'acme.card-2', viewSchemaRanges: [range(2, 5)] })))),
      // Same descriptor id in another cell.
      code(registry.register(text(card({ renderKey: 'list', targets: ['tui'] })))),
      code(registry.register(web(card({ id: 'acme.bad', renderKey: 'bad', packageDigest: 'not-a-digest' })))),
      code(
        registry.register(
          web(card({ id: 'acme.inverted', renderKey: 'inverted', viewSchemaRanges: [range(3, 1)] })),
        ),
      ),
      code(registry.register(text(card({ id: 'acme.no-component', renderKey: 'plain', targets: ['web'] })))),
      ...[
        { renderKey: 7 },
        { target: 'tv' },
        { viewSchema: { typeId: TYPE, revision: 1.5, digest: DIGEST } },
        { viewSchema: { revision: 2, digest: DIGEST } },
        { requiredFeatures: 'links' },
        { requiredFeatures: [1] },
      ].map((change) =>
        kind(registry.resolve({ ...ask('card', 'web', 2), ...change } as unknown as Request)),
      ),
    ]
    const separate = code(registry.register(later))
    const firstStill = leased(registry.resolve(ask('card', 'web', 2)), host, first)
    const laterServed = leased(registry.resolve(ask('card', 'web', 5)), host, later)
    host.refuseNext(DENIED)
    const refused = registry.resolve(ask('card', 'web', 2))
    return (
      isDeepStrictEqual(refusals, [
        'invalid_input',
        'conflict',
        'conflict',
        ...Array.from({ length: 9 }, () => 'invalid_input'),
      ]) &&
      separate === 'ok' &&
      firstStill &&
      laterServed &&
      !refused.ok &&
      isDeepStrictEqual(refused.error, DENIED)
    )
  },

  async cancel({ factory }) {
    const { host, registry } = open(factory)
    const first = accepted(registry.register(web(card())))
    await first.dispose()
    const definition = web(card())
    const second = accepted(registry.register(definition))
    await first.dispose()
    return (
      first.ownerToken !== second.ownerToken &&
      leased(registry.resolve(ask('card', 'web', 2)), host, definition)
    )
  },

  async recover(binding) {
    const directory = mkdtempSync(join(tmpdir(), 'ui-registry-recover-'))
    const read = (name: string) => JSON.parse(readFileSync(join(directory, name), 'utf8')) as Selection
    try {
      writeFileSync(join(directory, PROFILE), JSON.stringify({ renderers: Object.keys(TEXT_RENDERERS) }))
      const exits = await binding.restart(directory)
      const before = read(KILLED)
      const after = read(REBUILT)
      return (
        isDeepStrictEqual(
          exits.map((exit) => exit.signal),
          ['SIGKILL', null],
        ) &&
        isDeepStrictEqual(
          exits.map((exit) => exit.pid),
          [before.pid, after.pid],
        ) &&
        !exits.some((exit) => exit.pid === pid) &&
        before.selected === 'acme.card-tui-3' &&
        after.selected === before.selected &&
        before.leased &&
        after.leased &&
        after.handle !== before.handle &&
        after.oldHandleRefused === true
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },

  async dispose({ factory }) {
    const { host, registry } = open(factory)
    const definition = web(card())
    const registration = accepted(registry.register(definition))
    const leasedFirst = leased(registry.resolve(ask('card', 'web', 2)), host, definition)
    await host.handles.at(-1)?.dispose()
    const leasedAgain = leased(registry.resolve(ask('card', 'web', 2)), host, definition)
    await registration.dispose()
    await registration.dispose()
    await Promise.all([registration.dispose(), registration.dispose()])
    return (
      leasedFirst &&
      leasedAgain &&
      host.handles.length === 2 &&
      kind(registry.resolve(ask('card', 'web', 2))) === 'fallback'
    )
  },
}

const FEATURES = ['register', 'resolve', 'bindRenderer']

const LIFECYCLE: Record<ScenarioName, ReuseLifecycle> = {
  select: 'call',
  normal: 'call',
  deny: 'call',
  cancel: 'cancel',
  recover: 'recover',
  dispose: 'dispose',
}

/** Register select, normal, deny, cancel, recover and dispose for one UI registry. */
export function registerUIRegistryContract(
  harness: ConformanceHarness,
  binding: UIRegistryConformanceBinding,
): void {
  const digests = [binding.providerDigest, binding.configDigest, binding.releaseSetDigest]
  for (const scenario of SCENARIOS) {
    harness.registerCase({
      contract: CONTRACT,
      scenario,
      qualification: 'required',
      providerId: binding.providerId,
      async run(): Promise<AssertionInput> {
        // A registry that throws fails its scenario instead of ending the run.
        const passed =
          digests.every((digest) => HEX.test(digest)) && (await CASES[scenario](binding).catch(() => false))
        return {
          id: `${CONTRACT}/${binding.providerId}/${scenario}`,
          providerDigest: binding.providerDigest,
          recipe: binding.recipe,
          features: [...FEATURES],
          build: binding.build,
          consumer: 'ui-registry-conformance-consumer',
          command: binding.command,
          status: passed ? 'passed' : 'failed',
          configDigest: binding.configDigest,
          releaseSetDigest: binding.releaseSetDigest,
          attachmentDigest: null,
          // Every scenario drives the registry through a recording host, a double for the client host.
          fixture: 'test-client-host',
          sharedEvidenceId: null,
          reuse: {
            scope: 'run',
            methodKind: 'local',
            lifecycle: LIFECYCLE[scenario],
            undeclaredConnection: false,
          },
          perImplementation: true,
          gate: null,
        }
      },
    })
  }
}
