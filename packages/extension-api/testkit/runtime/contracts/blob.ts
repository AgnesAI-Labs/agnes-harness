import { createHash } from 'node:crypto'
import type {
  BlobReadPort,
  ByteRangeResult,
  ByteReadStream,
  CallContext,
  Outcome,
} from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import {
  RuntimeClientTransportPolicy,
  RuntimeErrorDetails,
  RuntimeServiceCatalog,
} from '@agnes/protocol/runtime'
import { type BuildIdentity, type ReuseLifecycle, SCENARIOS, type ScenarioName } from '../evidence.js'
import {
  type AssertionInput,
  type CaseContext,
  type ConformanceHarness,
  createTestServiceContainer,
  type TestServiceBinding,
} from '../harness.js'

const CONTRACT = 'agh.blob'
const HEX = /^[a-f0-9]{64}$/
export const MIB = RuntimeClientTransportPolicy.maxRangeBytes

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Deterministic bytes. Another salt gives other content, so two seeds never share a digest. */
export const content = (size: number, salt: number): Uint8Array =>
  new Uint8Array(size).map((_, index) => (index + salt * 7 + (index >> 10)) % 251)

export const same = (left: unknown, right: unknown) => jcs(left) === jcs(right)

const refusalClass = (detail: string): string | undefined =>
  Object.hasOwn(RuntimeErrorDetails, detail)
    ? (RuntimeErrorDetails as Record<string, { code: string }>)[detail]?.code
    : undefined

/** What a range call returned: the refusal's detail code, or the facts of the bytes it delivered. */
export type RangeFact =
  | { readonly refused: string }
  | {
      readonly offset: number
      readonly totalBytes: number
      readonly bytes: number
      readonly digest: string
      /** The digest of the delivered bytes, computed by the suite. */
      readonly body: string
    }

export type EndFact = { readonly refused: string } | { readonly bytes: number; readonly digest: string }

/** What a stream delivered: bytes, largest chunk, the digest of all of it, bytes after an interruption, end. */
export type StreamFact =
  | { readonly refused: string }
  | {
      readonly delivered: number
      readonly largest: number
      readonly body: string
      readonly afterInterrupt: number
      readonly ended: EndFact
    }

type Hook = (stream: ByteReadStream) => Promise<void>

/** Runs a call. A throw or a rejection is a refusal the contract cannot classify. */
export async function outcomeOf<T>(
  call: () => Promise<Outcome<T>>,
): Promise<{ readonly value: T } | { readonly refused: string }> {
  try {
    const outcome = await call()
    return outcome.ok ? { value: outcome.value } : { refused: outcome.error.detailCode }
  } catch {
    return { refused: 'thrown' }
  }
}

export async function rangeFact(call: () => Promise<Outcome<ByteRangeResult>>): Promise<RangeFact> {
  const result = await outcomeOf(call)
  if ('refused' in result) return result
  const { bytes, offset, totalBytes, digest } = result.value
  return { offset, totalBytes, bytes: bytes.byteLength, digest, body: sha256(bytes) }
}

/** Pulls a stream to its end. `before` runs before the first pull, `interrupt` after the first chunk. */
export async function streamFact(
  call: () => Promise<Outcome<ByteReadStream>>,
  hooks: Readonly<{ before?: Hook; interrupt?: Hook; after?: Hook }> = {},
): Promise<StreamFact> {
  const result = await outcomeOf(call)
  if ('refused' in result) return result
  const stream = result.value
  const hash = createHash('sha256')
  let delivered = 0
  let largest = 0
  let afterInterrupt = 0
  let interrupted = false
  try {
    await hooks.before?.(stream)
    for await (const chunk of stream.chunks) {
      hash.update(chunk)
      delivered += chunk.byteLength
      largest = Math.max(largest, chunk.byteLength)
      if (interrupted) afterInterrupt += chunk.byteLength
      else if (hooks.interrupt) {
        interrupted = true
        await hooks.interrupt(stream)
      }
    }
    await hooks.after?.(stream)
  } catch {
    return { refused: 'thrown' }
  }
  const end = await outcomeOf(() => stream.ended)
  const ended = 'refused' in end ? end : { bytes: end.value.bytes, digest: end.value.digest }
  return { delivered, largest, body: hash.digest('hex'), afterInterrupt, ended }
}

export const expectRange = (bytes: Uint8Array, offset: number, length: number): RangeFact => {
  const body = bytes.subarray(offset, offset + length)
  const digest = sha256(body)
  return { offset, totalBytes: bytes.byteLength, bytes: body.byteLength, digest, body: digest }
}

/** The stream delivered exactly the bytes from `offset` in chunks of at most 1 MiB and ended ok. */
export function streamed(fact: StreamFact | undefined, bytes: Uint8Array, offset: number): boolean {
  if (fact === undefined || 'refused' in fact) return false
  const body = bytes.subarray(offset)
  const digest = sha256(body)
  return (
    fact.delivered === body.byteLength &&
    fact.largest <= MIB &&
    fact.body === digest &&
    same(fact.ended, { bytes: body.byteLength, digest })
  )
}

/** The stream delivered something before the interruption, nothing after, and ended refused as judged. */
export function interrupted(fact: StreamFact | undefined, ends: (detail: string) => boolean): boolean {
  if (fact === undefined || 'refused' in fact || !('refused' in fact.ended)) return false
  return fact.delivered > 0 && fact.delivered <= MIB && fact.afterInterrupt === 0 && ends(fact.ended.refused)
}

const endedWith = (fact: RangeFact | StreamFact | undefined, detail: string) =>
  fact !== undefined && 'ended' in fact && same(fact.ended, { refused: detail })

export const CONFORMANCE_SCOPE: CallContext['scope'] = {
  kind: 'session',
  installationId: 'conformance',
  runtimeId: 'conformance',
  workspaceId: 'conformance',
  sessionId: 'conformance',
}

export function callContext(principalRef: string, authorizationRef: string, aborted = false): CallContext {
  const controller = new AbortController()
  if (aborted) controller.abort()
  return {
    principalRef,
    scope: CONFORMANCE_SCOPE,
    bindingId: 'conformance-binding',
    invocationId: 'conformance-invocation',
    deadline: '2100-01-01T00:00:00.000Z',
    traceRef: 'conformance-trace',
    authorizationRef,
    signal: controller.signal,
  }
}

/** The authorization ref the suite reads with; any other is a stranger's. */
export const BLOB_READER = 'blob-reader'

/** The read check a binding wires into its provider: the reader may read a ref until it is revoked. */
export interface BlobReadGate {
  allows(context: CallContext, ref: Wire.BlobRef): boolean
  revoke(ref: Wire.BlobRef): void
}

export function createBlobReadGate(): BlobReadGate {
  const revoked = new Set<string>()
  return {
    allows: (context, ref) => context.authorizationRef === BLOB_READER && !revoked.has(ref.pinId),
    revoke: (ref) => void revoked.add(ref.pinId),
  }
}

/** A provider's agh.blob actions, and its own entry that seals an upload staged by the caller. */
export interface BlobActions {
  upload(bytes: Uint8Array, context: CallContext): Promise<Wire.UploadRef>
  promote(request: Wire.BlobPromoteRequest, context: CallContext): Promise<Outcome<Wire.StagedBlobRef>>
  pin(request: Wire.BlobPinRequest, context: CallContext): Promise<Outcome<Wire.BlobRef>>
  unpin(request: Wire.BlobUnpinRequest, context: CallContext): Promise<Outcome<Wire.BlobUnpinResult>>
  inspect(request: Wire.BlobInspectRequest, context: CallContext): Promise<Outcome<Wire.BlobInspectResult>>
}

type Result = { readonly value: unknown } | { readonly refused: string }

/**
 * Another principal's promote of the owner's upload before and after the owner's, its pins of the
 * owner's staged blob for another and for the same owner ref, its unpin of the owner's pin, and that
 * unpin again once the owner released it, each as a refusal code or `accepted`; then the owner's view
 * of its pin and its unpin at revision 1.
 */
export type CrossPrincipalFacts = {
  readonly refusals: readonly string[]
  readonly inspected: Result
  readonly released: Result
}

const CROSS_OWNER: Wire.PublicRef = { kind: 'artifact', value: { artifactId: 'blob-owner', version: 1 } }
const crossObject = () => content(12, 9)

/** Drives one owner's upload and pin and another principal's attempts on them. */
export async function crossPrincipalFacts(actions: BlobActions): Promise<CrossPrincipalFacts> {
  const owner = callContext('blob-principal', BLOB_READER)
  const other = callContext('blob-other-principal', BLOB_READER)
  const take = async <T>(call: Promise<Outcome<T>>) => {
    const outcome = await call
    if (!outcome.ok) throw new Error(outcome.error.message)
    return outcome.value
  }
  const upload = await actions.upload(crossObject(), owner)
  const promote = { upload, expectedDigest: upload.digest }
  const early = await outcomeOf(() => actions.promote(promote, other))
  const stagedBlob = await take(actions.promote(promote, owner))
  const pinned = await take(actions.pin({ stagedBlob, ownerRef: CROSS_OWNER, retentionUntil: null }, owner))
  const otherRef: Wire.PublicRef = { kind: 'artifact', value: { artifactId: 'blob-other', version: 1 } }
  const attempts = [
    early,
    await outcomeOf(() => actions.promote(promote, other)),
    await outcomeOf(() => actions.pin({ stagedBlob, ownerRef: otherRef, retentionUntil: null }, other)),
    await outcomeOf(() => actions.pin({ stagedBlob, ownerRef: CROSS_OWNER, retentionUntil: null }, other)),
    await outcomeOf(() => actions.unpin({ pinId: pinned.pinId, expectedRevision: 1 }, other)),
  ]
  const inspected = await outcomeOf(() => actions.inspect({ ref: { kind: 'blob', value: pinned } }, owner))
  const released = await outcomeOf(() => actions.unpin({ pinId: pinned.pinId, expectedRevision: 1 }, owner))
  attempts.push(await outcomeOf(() => actions.unpin({ pinId: pinned.pinId, expectedRevision: 2 }, other)))
  return {
    refusals: attempts.map((attempt) => ('refused' in attempt ? attempt.refused : 'accepted')),
    inspected,
    released,
  }
}

/** Every attempt was refused as not the caller's, and the owner's pin is exactly as it was. */
export const crossPrincipalRefused = (facts: CrossPrincipalFacts) =>
  same(facts.refusals, Array(6).fill('permission_denied')) &&
  same(facts.inspected, {
    value: { status: 'pinned', bytes: 12, digest: sha256(crossObject()), ownerRefs: [CROSS_OWNER] },
  }) &&
  same(facts.released, { value: { released: true } })

/** One blob provider as the suite drives it. */
export interface BlobSubject {
  /** The binding the provider offers, carrying its read port. */
  readonly binding: TestServiceBinding
  readonly gate: BlobReadGate
  /** The read port of the instance open now; a reopen replaces it. */
  read(): BlobReadPort
  /** The provider's own test write entry: stores bytes and returns a pinned reference to them. */
  seed(bytes: Uint8Array): Promise<Wire.BlobRef>
  /** Replaces the stored bytes of `ref` behind the provider's back, leaving its records alone. */
  corrupt(ref: Wire.BlobRef, bytes: Uint8Array): Promise<void>
  /** Closes the provider and opens it again over the same storage. */
  reopen(): Promise<void>
  close(): Promise<void>
  /** Whether the provider's stored data is still on disk. */
  remains(): boolean
  /** Deny checks through them that another principal cannot act on an upload or a pin. */
  readonly actions: BlobActions
}

/**
 * Facts each scenario reports. The port only drives the provider and reads back; this module decides
 * whether the facts meet the blob read rules, so every implementation is judged the same way.
 */
export interface BlobObservations {
  readonly select: { readonly binding: TestServiceBinding }
  /**
   * A 2.5 MiB object read as [0, 1 MiB), [5, 12) and a range crossing the end, then streamed from 0,
   * from 1 MiB + 3 and from the end; an empty object streamed from 0 and given a positive range. `late`
   * streams an object whose stored last chunk is rewritten after the first chunk was taken.
   */
  readonly normal: {
    readonly ranges: readonly RangeFact[]
    readonly streams: readonly StreamFact[]
    readonly late: StreamFact
  }
  /**
   * A stranger's range and stream; six malformed or oversized ranges; a range at the end and a stream
   * past it; a range and a stream of an object whose stored bytes were cut short; a stream whose read
   * authorization is revoked after the first chunk. `selection` is what a consumer gets selecting the
   * offered binding in a fresh test service container: as offered, then asking a feature the binding
   * does not declare, another contract and another major, then registered without its read port, with
   * a port missing `openRead`, and once the container is closed.
   */
  readonly deny: {
    readonly unauthorized: readonly (RangeFact | StreamFact)[]
    readonly bounds: readonly RangeFact[]
    readonly pastEnd: readonly (RangeFact | StreamFact)[]
    readonly short: readonly (RangeFact | StreamFact)[]
    readonly revoked: StreamFact
    readonly selection: readonly string[]
    readonly crossPrincipal: CrossPrincipalFacts
  }
  /**
   * A range and a stream opened with an aborted signal; a stream cancelled twice and closed after its
   * first chunk; one closed twice and cancelled before any pull; one cancelled after it was drained.
   */
  readonly cancel: {
    readonly aborted: readonly (RangeFact | StreamFact)[]
    readonly cancelled: StreamFact
    readonly closed: StreamFact
    readonly finished: StreamFact
  }
  /** One range before and after the store is reopened, then a full stream of the same reference. */
  readonly recover: { readonly before: RangeFact; readonly after: RangeFact; readonly stream: StreamFact }
  /** Refusal codes of a range and a stream after close, and whether the stored data is still there. */
  readonly dispose: { readonly refusals: readonly (string | null)[]; readonly remains: boolean }
}

export type BlobContractPort = {
  readonly [K in ScenarioName]: (context: CaseContext) => Promise<BlobObservations[K]>
}

const normalObject = () => content(MIB * 2 + MIB / 2, 1)
const cancelObject = () => content(MIB * 2, 6)
const recoverObject = () => content(MIB + 7, 7)

/** Drives one blob provider through the six scenarios. */
export function blobContractPort(subject: BlobSubject): BlobContractPort {
  const reader = (aborted = false) => callContext('blob-principal', BLOB_READER, aborted)
  const range = (ref: Wire.BlobRef, offset: number, length: number, context = reader()) =>
    rangeFact(() => subject.read().readRange({ ref, offset, length }, context))
  const stream = (
    ref: Wire.BlobRef,
    offset: number,
    hooks: Parameters<typeof streamFact>[1] = {},
    context = reader(),
  ) => streamFact(() => subject.read().openRead({ ref, offset }, context), hooks)
  const stop: Hook = async (opened) => {
    await opened.cancel('conformance')
    await opened.cancel('conformance')
    await opened.close()
  }
  return {
    async select() {
      return { binding: subject.binding }
    },
    async normal() {
      const object = normalObject()
      const size = object.byteLength
      const ref = await subject.seed(object)
      const empty = await subject.seed(new Uint8Array())
      const lateBytes = content(size, 2)
      const late = await subject.seed(lateBytes)
      const rewritten = lateBytes.slice().fill(0, MIB * 2)
      return {
        ranges: [
          await range(ref, 0, MIB),
          await range(ref, 5, 7),
          await range(ref, size - 10, 100),
          await range(empty, 0, 1),
        ],
        streams: [
          await stream(ref, 0),
          await stream(ref, MIB + 3),
          await stream(ref, size),
          await stream(empty, 0),
        ],
        late: await stream(late, 0, { interrupt: () => subject.corrupt(late, rewritten) }),
      }
    },
    async deny() {
      const small = content(10, 3)
      const ref = await subject.seed(small)
      const stranger = callContext('blob-principal', 'blob-stranger')
      const bounds: RangeFact[] = []
      for (const [offset, length] of [
        [0, MIB + 1],
        [2 ** 53, 1],
        [-0, 1],
        [0, -0],
        [1.5, 1],
        [Number.MAX_SAFE_INTEGER, 2],
      ] as const)
        bounds.push(await range(ref, offset, length))
      const short = content(10, 4)
      const shortRef = await subject.seed(short)
      await subject.corrupt(shortRef, short.subarray(0, 5))
      const revokedRef = await subject.seed(content(MIB * 2, 5))
      const offered = subject.binding
      const { requirement } = offered
      const features = [...requirement.features, 'conformance.undeclared-feature.v1']
      const partial = { readRange: subject.read().readRange } as BlobReadPort
      return {
        unauthorized: [await range(ref, 0, 1, stranger), await stream(ref, 0, {}, stranger)],
        bounds,
        pastEnd: [await range(ref, small.byteLength, 1), await stream(ref, small.byteLength + 1)],
        short: [await range(shortRef, 0, short.byteLength), await stream(shortRef, 0)],
        revoked: await stream(revokedRef, 0, { interrupt: async () => subject.gate.revoke(revokedRef) }),
        selection: [
          await selectRead(offered),
          await selectRead(offered, { ...requirement, features }),
          await selectRead(offered, { ...requirement, contract: 'agh.artifacts' }),
          await selectRead(offered, { ...requirement, major: requirement.major + 1 }),
          await selectRead({ requirement, binding: offered.binding }),
          await selectRead({ ...offered, blobRead: partial }),
          await selectRead(offered, requirement, true),
        ],
        crossPrincipal: await crossPrincipalFacts(subject.actions),
      }
    },
    async cancel() {
      const ref = await subject.seed(cancelObject())
      const aborted = reader(true)
      const shut: Hook = async (opened) => {
        await opened.close()
        await opened.close()
        await opened.cancel('conformance')
      }
      return {
        aborted: [await range(ref, 0, 1, aborted), await stream(ref, 0, {}, aborted)],
        cancelled: await stream(ref, 0, { interrupt: stop }),
        closed: await stream(ref, 0, { before: shut }),
        finished: await stream(ref, 0, { after: stop }),
      }
    },
    async recover() {
      const ref = await subject.seed(recoverObject())
      const before = await range(ref, 3, 64)
      await subject.reopen()
      return { before, after: await range(ref, 3, 64), stream: await stream(ref, 0) }
    },
    async dispose() {
      const ref = await subject.seed(content(16, 8))
      await subject.close()
      const facts = [await range(ref, 0, 1), await stream(ref, 0)]
      return {
        refusals: facts.map((fact) => ('refused' in fact ? fact.refused : null)),
        remains: subject.remains(),
      }
    },
  }
}

/** Registers the offered binding and checks the container resolves it to this provider and its port. */
export function selected(
  binding: TestServiceBinding,
  context: CaseContext,
  providerId: string,
  feature: string,
  port: 'blobRead' | 'artifactAccess',
): boolean {
  const { requirement } = binding
  const entry = RuntimeServiceCatalog[requirement.contract as keyof typeof RuntimeServiceCatalog]
  if (entry === undefined || requirement.major !== entry.major || !requirement.features.includes(feature))
    return false
  try {
    context.container.register(binding)
  } catch {
    return false
  }
  const chosen = context.container.dependencies.get(requirement)
  return chosen.ok && chosen.value.binding.providerId === providerId && chosen.value[port] !== undefined
}

/**
 * Selects `asked` from a fresh test service container holding `offered`, closed first when `closed`:
 * the container's refusal code, `operation_not_supported` when the selection lacks a read method, as a
 * consuming assembly refuses it, or `selected`.
 */
async function selectRead(offered: TestServiceBinding, asked = offered.requirement, closed = false) {
  const container = createTestServiceContainer()
  container.register(offered)
  if (closed) await container.dependencies.close()
  const chosen = container.dependencies.get(asked)
  if (!chosen.ok) return chosen.error.detailCode
  const port = chosen.value.blobRead
  const complete = typeof port?.readRange === 'function' && typeof port.openRead === 'function'
  return complete ? 'selected' : 'operation_not_supported'
}

const malformed = (fact: RangeFact) =>
  'refused' in fact && ['invalid_input', 'quota'].includes(refusalClass(fact.refused) ?? '')

export type Judge<O extends Record<ScenarioName, unknown>> = {
  readonly [K in ScenarioName]: (seen: O[K], context: CaseContext, providerId: string) => boolean
}

const JUDGE: Judge<BlobObservations> = {
  select: (seen, context, providerId) =>
    seen.binding.requirement.contract === CONTRACT &&
    selected(seen.binding, context, providerId, 'blob-read.v1', 'blobRead'),
  normal: (seen) => {
    const object = normalObject()
    const size = object.byteLength
    const empty = new Uint8Array()
    return (
      same(seen.ranges, [
        expectRange(object, 0, MIB),
        expectRange(object, 5, 7),
        expectRange(object, size - 10, 100),
        { refused: 'range_not_satisfiable' },
      ]) &&
      seen.streams.length === 4 &&
      streamed(seen.streams[0], object, 0) &&
      streamed(seen.streams[1], object, MIB + 3) &&
      streamed(seen.streams[2], object, size) &&
      streamed(seen.streams[3], empty, 0) &&
      endedWith(seen.late, 'integrity')
    )
  },
  deny: (seen) =>
    same(seen.unauthorized, [{ refused: 'permission_denied' }, { refused: 'permission_denied' }]) &&
    seen.bounds.length === 6 &&
    seen.bounds.every(malformed) &&
    same(seen.pastEnd, [{ refused: 'range_not_satisfiable' }, { refused: 'range_not_satisfiable' }]) &&
    same(seen.short[0], { refused: 'integrity' }) &&
    (same(seen.short[1], { refused: 'integrity' }) || endedWith(seen.short[1], 'integrity')) &&
    interrupted(seen.revoked, (detail) => refusalClass(detail) === 'denied') &&
    same(seen.selection, [
      'selected',
      'feature_missing',
      'service_not_registered',
      'service_not_registered',
      'operation_not_supported',
      'operation_not_supported',
      'service_container_closed',
    ]) &&
    crossPrincipalRefused(seen.crossPrincipal),
  cancel: (seen) =>
    same(seen.aborted, [{ refused: 'cancelled' }, { refused: 'cancelled' }]) &&
    interrupted(seen.cancelled, (detail) => detail === 'cancelled') &&
    same(seen.closed, {
      delivered: 0,
      largest: 0,
      body: sha256(new Uint8Array()),
      afterInterrupt: 0,
      ended: { refused: 'cancelled' },
    }) &&
    streamed(seen.finished, cancelObject(), 0),
  recover: (seen) => {
    const object = recoverObject()
    const expected = expectRange(object, 3, 64)
    return same(seen.before, expected) && same(seen.after, expected) && streamed(seen.stream, object, 0)
  },
  dispose: (seen) =>
    seen.refusals.length === 2 &&
    seen.refusals.every((code) => code !== null && refusalClass(code) !== undefined) &&
    seen.remains,
}

const FEATURES: Record<ScenarioName, readonly string[]> = {
  select: ['blob-read.v1'],
  normal: ['readRange', 'openRead'],
  deny: ['readRange', 'openRead'],
  cancel: ['readRange', 'openRead'],
  recover: ['readRange', 'openRead'],
  dispose: ['readRange', 'openRead'],
}

const LIFECYCLE: Record<ScenarioName, ReuseLifecycle> = {
  select: 'call',
  normal: 'call',
  deny: 'call',
  cancel: 'cancel',
  recover: 'recover',
  dispose: 'dispose',
}

export interface ConformanceBinding<Port> {
  readonly providerId: string
  readonly recipe: string
  readonly command: string
  readonly build: BuildIdentity
  /** Hex digests of the provider code, its options and the release set it ships in. */
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
  readonly port: Port
}

/**
 * Registers the six cases of one contract; a scenario that throws is a failed case. A `suite` registers
 * a feature's cases beside the contract's own, under ids and a consumer of its name.
 */
export function registerScenarios<O extends Record<ScenarioName, unknown>>(
  harness: ConformanceHarness,
  contract: string,
  binding: ConformanceBinding<{ readonly [K in ScenarioName]: (context: CaseContext) => Promise<O[K]> }>,
  judge: Judge<O>,
  features: Record<ScenarioName, readonly string[]>,
  suite?: Readonly<{ name: string; methodKind: string }>,
): void {
  const label = suite
    ? `${contract}/${binding.providerId}/${suite.name}`
    : `${contract}/${binding.providerId}`
  const digests = [binding.providerDigest, binding.configDigest, binding.releaseSetDigest]
  const observe = async <K extends ScenarioName>(scenario: K, context: CaseContext) => {
    try {
      return judge[scenario](await binding.port[scenario](context), context, binding.providerId)
    } catch {
      return false
    }
  }
  for (const scenario of SCENARIOS) {
    harness.registerCase({
      contract,
      scenario,
      qualification: 'required',
      providerId: binding.providerId,
      async run(context): Promise<AssertionInput> {
        const passed = digests.every((digest) => HEX.test(digest)) && (await observe(scenario, context))
        return {
          id: `${label}/${scenario}`,
          providerDigest: binding.providerDigest,
          recipe: binding.recipe,
          features: [...features[scenario]],
          build: binding.build,
          consumer: suite
            ? `${contract}-${suite.name}-conformance-consumer`
            : `${contract}-conformance-consumer`,
          command: binding.command,
          status: passed ? 'passed' : 'failed',
          configDigest: binding.configDigest,
          releaseSetDigest: binding.releaseSetDigest,
          attachmentDigest: null,
          fixture: scenario === 'select' ? 'test-service-container' : null,
          sharedEvidenceId: null,
          reuse: {
            scope: 'run',
            methodKind: suite?.methodKind ?? 'query',
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

/** Register select, normal, deny, cancel, recover and dispose for one blob provider. */
export function registerBlobContract(
  harness: ConformanceHarness,
  binding: ConformanceBinding<BlobContractPort>,
): void {
  registerScenarios<BlobObservations>(harness, CONTRACT, binding, JUDGE, FEATURES)
}
