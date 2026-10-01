import type { ArtifactAccessPort, ByteReadStream, Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { RuntimeArtifactPolicy, RuntimeClientTransportWire, validateRuntime } from '@agnes/protocol/runtime'
import type { ScenarioName } from '../evidence.js'
import type { CaseContext, ConformanceHarness, TestServiceBinding } from '../harness.js'
import {
  CONFORMANCE_SCOPE,
  type ConformanceBinding,
  callContext,
  content,
  expectRange,
  interrupted,
  type Judge,
  MIB,
  outcomeOf,
  type RangeFact,
  rangeFact,
  registerScenarios,
  type StreamFact,
  same,
  selected,
  streamed,
  streamFact,
} from './blob.js'

const CONTRACT = 'agh.artifacts'
const TICKET_TTL_MS = RuntimeArtifactPolicy.downloadTicketTtlMs
const DOWNLOAD = RuntimeClientTransportWire.routes.download.path
const DOWNLOAD_PREFIX = DOWNLOAD.slice(0, DOWNLOAD.indexOf('{'))

/**
 * The reader a binding grants read and download on every artifact it publishes, and whose authorization
 * ref its Host check accepts. Any other principal or authorization ref is a stranger.
 */
export const ARTIFACT_READER = {
  principalRef: 'artifact-reader',
  authorizationRef: 'artifact-reader-authorization',
  scope: CONFORMANCE_SCOPE,
} as const

/** One artifacts provider as the suite drives it. */
export interface ArtifactsSubject {
  /** The binding the provider offers, carrying its access port. */
  readonly binding: TestServiceBinding
  /** The access port of the instance open now; a reopen replaces it. */
  access(): ArtifactAccessPort
  /**
   * Publishes `bytes` as a ready version, the next version of `artifactId` when given, and grants the
   * reader read and download on exactly that version.
   */
  publish(bytes: Uint8Array, artifactId?: Wire.Id): Promise<Wire.ArtifactRef>
  revoke(ref: Wire.ArtifactRef): Promise<void>
  /** Revokes the reader's grant on `ref`, which moves its grant revision on. */
  revokeGrant(ref: Wire.ArtifactRef): Promise<void>
  /** The provider's clock in milliseconds, and moving it forward. */
  now(): number
  advance(ms: number): void
  /** Calls the provider has made to its selected blob read port so far. */
  blobReads(): number
  reopen(): Promise<void>
  close(): Promise<void>
  /** Whether the provider's stored data is still on disk. */
  remains(): boolean
  /** Local storage locations. None may appear in any output. */
  readonly locations: readonly string[]
  /** A narrower ticket lifetime the provider was configured with, or null. */
  readonly ticketTtlMs: number | null
}

export type ViewFact = Wire.ArtifactViewRef | { readonly refused: string }
export type TicketFact = Wire.ArtifactDownloadTicket | { readonly refused: string }

/**
 * Facts each scenario reports. The port only drives the provider and reads back; this module decides
 * whether the facts meet the artifact access rules, so every implementation is judged the same way.
 */
export interface ArtifactsObservations {
  readonly select: { readonly binding: TestServiceBinding }
  /**
   * A 1.5 MiB version described, read as [0, 1 MiB), [3, 8) and across its end, streamed with no offset
   * and from its end; a download ticket asked for twice a second apart; the head of that version and of
   * a second version published after it. `outputs` is every result serialized, for the leak check.
   */
  readonly normal: {
    readonly ref: Wire.ArtifactRef
    readonly next: Wire.ArtifactRef
    readonly view: ViewFact
    readonly ranges: readonly RangeFact[]
    readonly streams: readonly StreamFact[]
    readonly tickets: readonly TicketFact[]
    readonly issuedAt: number
    readonly blobReads: number
    readonly versions: readonly RangeFact[]
    readonly ticketTtlMs: number | null
    readonly outputs: readonly string[]
    readonly locations: readonly string[]
  }
  /**
   * Refusal codes of a stranger's describe, range, stream and ticket, another principal's range, four
   * bad ranges, a stream past the end and a ticket request id reused for another disposition, with the
   * blob reads they caused. Then one stream interrupted by revoking the reader's grant and one by
   * revoking the version, each followed by a range and a new ticket request.
   */
  readonly deny: {
    readonly refusals: readonly string[]
    readonly blobReads: number
    readonly grant: { readonly stream: StreamFact; readonly after: readonly string[] }
    readonly revoked: { readonly stream: StreamFact; readonly after: readonly string[] }
    readonly outputs: readonly string[]
    readonly locations: readonly string[]
  }
  /**
   * Describe, range, stream and ticket with an aborted signal; a stream cancelled twice and closed after
   * its first chunk; a ticket, the same request at its expiry and a second later, then a new request.
   */
  readonly cancel: {
    readonly aborted: readonly string[]
    readonly stream: StreamFact
    readonly tickets: readonly TicketFact[]
  }
  /** Describe, a range and a ticket before and after the store is reopened, then a full stream. */
  readonly recover: {
    readonly ref: Wire.ArtifactRef
    readonly before: { readonly view: ViewFact; readonly range: RangeFact; readonly ticket: TicketFact }
    readonly after: { readonly view: ViewFact; readonly range: RangeFact; readonly ticket: TicketFact }
    readonly stream: StreamFact
  }
  /** Refusal codes of describe, a range and a stream after close, and whether the data is still there. */
  readonly dispose: { readonly refusals: readonly string[]; readonly remains: boolean }
}

export type ArtifactsContractPort = {
  readonly [K in ScenarioName]: (context: CaseContext) => Promise<ArtifactsObservations[K]>
}

const code = (fact: object): string =>
  'refused' in fact && typeof fact.refused === 'string' ? fact.refused : ''

const resultOf = async <T>(call: () => Promise<Outcome<T>>): Promise<T | { readonly refused: string }> => {
  const result = await outcomeOf(call)
  return 'refused' in result ? result : result.value
}

/** Serializes every result the port returns, stream ends included, without the bytes themselves. */
function recording(access: ArtifactAccessPort, sink: string[]): ArtifactAccessPort {
  const note = <T>(outcome: Outcome<T>): Outcome<T> => {
    const value = outcome.ok ? outcome.value : outcome.error
    sink.push(JSON.stringify(value, (_, item) => (item instanceof Uint8Array ? item.byteLength : item)))
    return outcome
  }
  const ends = (outcome: Outcome<ByteReadStream>) => {
    if (outcome.ok) void outcome.value.ended.then(note, () => undefined)
    return note(outcome)
  }
  return {
    describe: async (input, context) => note(await access.describe(input, context)),
    openDownload: async (input, context) => note(await access.openDownload(input, context)),
    readRange: async (input, context) => note(await access.readRange(input, context)),
    openStream: async (input, context) => ends(await access.openStream(input, context)),
    redeemDownload: async (request, context) => note(await access.redeemDownload(request, context)),
  }
}

const artifactObject = () => content(MIB + MIB / 2, 11)
const nextObject = () => content(100, 12)
const recoverObject = () => content(MIB + 9, 41)

/** Drives one artifacts provider through the six scenarios. */
export function artifactsContractPort(subject: ArtifactsSubject): ArtifactsContractPort {
  const reader = (aborted = false) =>
    callContext(ARTIFACT_READER.principalRef, ARTIFACT_READER.authorizationRef, aborted)
  const exact = (ref: Wire.ArtifactRef) => ({ artifactId: ref.artifactId, version: ref.version })
  const drive = (sink: string[]) => {
    const access = () => recording(subject.access(), sink)
    return {
      describe: (ref: Wire.ArtifactRef, context = reader()) =>
        resultOf(() => access().describe(exact(ref), context)),
      range: (ref: Wire.ArtifactRef, offset: number, length: number, context = reader()) =>
        rangeFact(() => access().readRange({ ...exact(ref), offset, length }, context)),
      stream: (
        ref: Wire.ArtifactRef,
        offset?: number,
        hooks: Parameters<typeof streamFact>[1] = {},
        context = reader(),
      ) =>
        streamFact(
          () => access().openStream(offset === undefined ? exact(ref) : { ...exact(ref), offset }, context),
          hooks,
        ),
      ticket: (
        ref: Wire.ArtifactRef,
        requestId: string,
        disposition: 'inline' | 'attachment' = 'attachment',
        context = reader(),
      ) =>
        resultOf(() => access().openDownload({ requestId, input: { ...exact(ref), disposition } }, context)),
    }
  }
  return {
    async select() {
      return { binding: subject.binding }
    },
    async normal() {
      const outputs: string[] = []
      const { describe, range, stream, ticket } = drive(outputs)
      const object = artifactObject()
      const size = object.byteLength
      const ref = await subject.publish(object)
      const readsBefore = subject.blobReads()
      const view = await describe(ref)
      const ranges = [await range(ref, 0, MIB), await range(ref, 3, 5), await range(ref, size - 10, 100)]
      const streams = [await stream(ref), await stream(ref, size)]
      const blobReads = subject.blobReads() - readsBefore
      const issuedAt = subject.now()
      const first = await ticket(ref, 'download-normal')
      subject.advance(1000)
      const tickets = [first, await ticket(ref, 'download-normal')]
      const next = await subject.publish(nextObject(), ref.artifactId)
      const versions = [await range(ref, 0, 64), await range(next, 0, 64)]
      return {
        ref,
        next,
        view,
        ranges,
        streams,
        tickets,
        issuedAt,
        blobReads,
        versions,
        ticketTtlMs: subject.ticketTtlMs,
        outputs,
        locations: subject.locations,
      }
    },
    async deny() {
      const outputs: string[] = []
      const { describe, range, stream, ticket } = drive(outputs)
      const object = content(64, 21)
      const ref = await subject.publish(object)
      const stranger = callContext(ARTIFACT_READER.principalRef, 'artifact-stranger')
      const other = callContext('artifact-other', ARTIFACT_READER.authorizationRef)
      await ticket(ref, 'download-deny')
      const readsBefore = subject.blobReads()
      const refusals = [
        await describe(ref, stranger),
        await range(ref, 0, 1, stranger),
        await stream(ref, 0, {}, stranger),
        await ticket(ref, 'download-stranger', 'attachment', stranger),
        await range(ref, 0, 1, other),
        await range(ref, 0, MIB + 1),
        await range(ref, -0, 1),
        await range(ref, Number.MAX_SAFE_INTEGER, 2),
        await range(ref, object.byteLength, 1),
        await stream(ref, object.byteLength + 1),
        await ticket(ref, 'download-deny', 'inline'),
      ].map(code)
      const blobReads = subject.blobReads() - readsBefore
      const granted = await subject.publish(content(MIB * 2, 22))
      const grantStream = await stream(granted, 0, { interrupt: () => subject.revokeGrant(granted) })
      const afterGrant = [await range(granted, 0, 1), await ticket(granted, 'download-grant')].map(code)
      const withdrawn = await subject.publish(content(MIB * 2, 23))
      const revokedStream = await stream(withdrawn, 0, { interrupt: () => subject.revoke(withdrawn) })
      const afterRevoke = [await range(withdrawn, 0, 1), await ticket(withdrawn, 'download-revoked')].map(
        code,
      )
      return {
        refusals,
        blobReads,
        grant: { stream: grantStream, after: afterGrant },
        revoked: { stream: revokedStream, after: afterRevoke },
        outputs,
        locations: subject.locations,
      }
    },
    async cancel() {
      const { describe, range, stream, ticket } = drive([])
      const ref = await subject.publish(content(MIB * 2, 31))
      const aborted = reader(true)
      const codes = [
        await describe(ref, aborted),
        await range(ref, 0, 1, aborted),
        await stream(ref, undefined, {}, aborted),
        await ticket(ref, 'download-aborted', 'attachment', aborted),
      ].map(code)
      const cancelled = await stream(ref, undefined, {
        interrupt: async (opened) => {
          await opened.cancel('conformance')
          await opened.cancel('conformance')
          await opened.close()
        },
      })
      const first = await ticket(ref, 'download-expiry')
      subject.advance(('refused' in first ? subject.now() : Date.parse(first.expiresAt)) - subject.now())
      const atExpiry = await ticket(ref, 'download-expiry')
      subject.advance(1000)
      const later = await ticket(ref, 'download-expiry')
      return {
        aborted: codes,
        stream: cancelled,
        tickets: [first, atExpiry, later, await ticket(ref, 'download-fresh')],
      }
    },
    async recover() {
      const { describe, range, stream, ticket } = drive([])
      const ref = await subject.publish(recoverObject())
      const read = async () => ({
        view: await describe(ref),
        range: await range(ref, 7, 64),
        ticket: await ticket(ref, 'download-recover'),
      })
      const before = await read()
      await subject.reopen()
      return { ref, before, after: await read(), stream: await stream(ref) }
    },
    async dispose() {
      const { describe, range, stream } = drive([])
      const ref = await subject.publish(content(32, 51))
      await subject.close()
      const refusals = [await describe(ref), await range(ref, 0, 1), await stream(ref)].map(code)
      return { refusals, remains: subject.remains() }
    },
  }
}

/** A valid ticket for exactly this version, on the download route and never an absolute URL. */
function ticketFor(fact: TicketFact | undefined, ref: Wire.ArtifactRef): fact is Wire.ArtifactDownloadTicket {
  return (
    fact !== undefined &&
    !('refused' in fact) &&
    validateRuntime('ArtifactDownloadTicket', fact).ok &&
    fact.artifactId === ref.artifactId &&
    fact.version === ref.version &&
    fact.url.startsWith(DOWNLOAD_PREFIX)
  )
}

const ready = (view: ViewFact, ref: Wire.ArtifactRef, size: number) =>
  !('refused' in view) &&
  validateRuntime('ArtifactViewRef', view).ok &&
  view.status === 'ready' &&
  view.size === size &&
  view.artifactId === ref.artifactId &&
  view.version === ref.version

/** No output names a storage location or carries an absolute URL such as a bucket or file address. */
const clean = (outputs: readonly string[], locations: readonly string[]) =>
  outputs.length > 0 &&
  locations.length > 0 &&
  outputs.every((text) => !text.includes('://') && locations.every((location) => !text.includes(location)))

const denied = (detail: string) => ['permission_denied', 'revoked'].includes(detail)

const JUDGE: Judge<ArtifactsObservations> = {
  select: (seen, context, providerId) =>
    seen.binding.requirement.contract === CONTRACT &&
    selected(seen.binding, context, providerId, 'artifact-access.v1', 'artifactAccess'),
  normal: (seen) => {
    const object = artifactObject()
    const size = object.byteLength
    const [first, repeat] = seen.tickets
    const lifetime = Math.min(TICKET_TTL_MS, seen.ticketTtlMs ?? TICKET_TTL_MS)
    return (
      ready(seen.view, seen.ref, size) &&
      same(seen.ranges, [
        expectRange(object, 0, MIB),
        expectRange(object, 3, 5),
        expectRange(object, size - 10, 100),
      ]) &&
      streamed(seen.streams[0], object, 0) &&
      streamed(seen.streams[1], object, size) &&
      seen.blobReads >= 5 &&
      ticketFor(first, seen.ref) &&
      same(repeat, first) &&
      Date.parse(first.expiresAt) - seen.issuedAt === lifetime &&
      seen.next.artifactId === seen.ref.artifactId &&
      seen.next.version === seen.ref.version + 1 &&
      same(seen.versions, [expectRange(object, 0, 64), expectRange(nextObject(), 0, 64)]) &&
      clean(seen.outputs, seen.locations)
    )
  },
  deny: (seen) =>
    same(seen.refusals, [
      ...Array(5).fill('permission_denied'),
      'range_bytes',
      'invalid_request',
      'invalid_request',
      'range_not_satisfiable',
      'range_not_satisfiable',
      'idempotency_conflict',
    ]) &&
    seen.blobReads === 0 &&
    interrupted(seen.grant.stream, denied) &&
    seen.grant.after.length === 2 &&
    seen.grant.after.every(denied) &&
    interrupted(seen.revoked.stream, (detail) => detail === 'revoked') &&
    same(seen.revoked.after, ['revoked', 'revoked']) &&
    clean(seen.outputs, seen.locations),
  cancel: (seen) => {
    const [first, atExpiry, later, fresh] = seen.tickets
    return (
      same(seen.aborted, ['cancelled', 'cancelled', 'cancelled', 'cancelled']) &&
      interrupted(seen.stream, (detail) => detail === 'cancelled') &&
      first !== undefined &&
      !('refused' in first) &&
      same([atExpiry, later], [{ refused: 'ticket_expired' }, { refused: 'ticket_expired' }]) &&
      fresh !== undefined &&
      !('refused' in fresh) &&
      fresh.url !== first.url &&
      Date.parse(fresh.expiresAt) > Date.parse(first.expiresAt)
    )
  },
  recover: (seen) =>
    same(seen.before, seen.after) &&
    ready(seen.before.view, seen.ref, recoverObject().byteLength) &&
    same(seen.before.range, expectRange(recoverObject(), 7, 64)) &&
    ticketFor(seen.before.ticket, seen.ref) &&
    streamed(seen.stream, recoverObject(), 0),
  dispose: (seen) =>
    seen.refusals.length === 3 && seen.refusals.every((detail) => detail !== '') && seen.remains,
}

const FEATURES: Record<ScenarioName, readonly string[]> = {
  select: ['artifact-access.v1'],
  normal: ['describe', 'readRange', 'openStream', 'openDownload'],
  deny: ['describe', 'readRange', 'openStream', 'openDownload'],
  cancel: ['describe', 'readRange', 'openStream', 'openDownload'],
  recover: ['describe', 'readRange', 'openStream', 'openDownload'],
  dispose: ['describe', 'readRange', 'openStream'],
}

/** Register select, normal, deny, cancel, recover and dispose for one artifacts provider. */
export function registerArtifactsContract(
  harness: ConformanceHarness,
  binding: ConformanceBinding<ArtifactsContractPort>,
): void {
  registerScenarios<ArtifactsObservations>(harness, CONTRACT, binding, JUDGE, FEATURES)
}
