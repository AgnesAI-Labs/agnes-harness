import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import type {
  ActionFrame,
  ActionHandlerScope,
  CallContext,
  DataRef,
  FactoryContext,
  LoopReadPorts,
  Outcome,
  PreparedAction,
  ProviderFactory,
  ScopedDependencies,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { boundedCanonicalJson, canonicalJsonDigest, RuntimeMethodSchemaRefs } from '@agnes/protocol/runtime'

export interface MediaContractDeployment {
  readonly binding: W.BindingRef
  readonly packageDigest: string
  readonly configSchema: W.SchemaRef
  readonly requires: readonly W.ServiceRequirement[]
  readonly state: W.BindingRef
  readonly limits: Readonly<
    Record<
      | 'maxManifestEntries'
      | 'maxSelectedImages'
      | 'maxSelectedBlocks'
      | 'maxBytesPerImage'
      | 'maxDimensionPerImage'
      | 'maxPixelsPerImage'
      | 'maxSelectedBytes'
      | 'maxSelectedPixels',
      number
    >
  >
  readonly sources: {
    open(
      ref: W.PublicRef,
      context: CallContext,
    ): Promise<
      Outcome<{
        blob: W.BlobRef
        bytes: Uint8Array
        version: string
        trust: W.ContextItem['trust']
        sourceTool: string
      }>
    >
    epoch(context: CallContext): string
  }
  readonly vision: null | {
    resolve(
      context: CallContext,
      plan: W.MediaPlan,
    ): Promise<
      Outcome<{
        model: W.BindingRef
        route: W.ModelRouteSnapshot
        generation: W.GenerationOptions
        sessionParameterRef: W.DomainReference
        credentialRef: W.SecretHandle | null
        parserVersion: string
        viewSchema: W.SchemaRef
      }>
    >
  }
  authorize(context: CallContext): boolean
}
export type MediaFactoryMaker = (deployment: MediaContractDeployment) => ProviderFactory<ServiceProvider>

/** The persistent world a restart keeps: sources, published child receipts and effect counters. */
export interface MediaWorld {
  bytes: Map<string, Uint8Array>
  receipts: Map<string, W.ActionResultView>
  counters: { vision: number; computes: number; children: number; preparedIds: number }
  allowed: { value: boolean }
}
export const newWorld = (): MediaWorld => ({
  bytes: new Map(),
  receipts: new Map(),
  counters: { vision: 0, computes: 0, children: 0, preparedIds: 0 },
  allowed: { value: true },
})

export interface MediaContractFixture {
  factory: ProviderFactory<ServiceProvider>
  configuration: DataRef
  dependencies: ScopedDependencies
  factoryContext: FactoryContext
  call: CallContext
  scope: ActionHandlerScope
  nativeFrame: ActionFrame
  convertFrame: ActionFrame
  foreignFrame: ActionFrame
  plans: { native: W.MediaPlan; convert: W.MediaPlan }
  visionText: string
  visionUsage: readonly W.UsageFactRef[]
  ports: LoopReadPorts
  dispatch(child: PreparedAction): Promise<ActionFrame['receipts']['items'][number]>
  visionRequests(): number
  computeCalls(): number
  childrenPrepared(): number
  revoke(): Promise<void>
  restart(): Promise<MediaContractFixture>
  close(): Promise<void>
}

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const local = (typeId: string): W.SchemaRef => ({
  typeId,
  revision: 1,
  digest: canonicalJsonDigest({ typeId, revision: 1 }),
})
const digestOf = (value: unknown) => canonicalJsonDigest(value as W.JsonValue)
function pack(schema: W.SchemaRef, value: unknown): DataRef {
  const bounded = boundedCanonicalJson(value, { maxBytes: 65_536, maxDepth: 32, maxMembers: 10_000 })
  if (!bounded.ok) throw new Error('fixture data exceeds its bound')
  return {
    kind: 'inline',
    schema,
    value: bounded.value.json,
    digest: canonicalJsonDigest(bounded.value.json),
    bytes: bounded.value.bytes,
  }
}

const u32 = (value: number) => [value >>> 24, value >>> 16, value >>> 8, value].map((b) => b & 0xff)
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function chunk(type: string, data: readonly number[]): number[] {
  const typed = [...Buffer.from(type, 'ascii'), ...data]
  let crc = 0xffffffff
  for (const byte of typed) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return [...u32(data.length), ...typed, ...u32((crc ^ 0xffffffff) >>> 0)]
}
/** A valid 1-bit PNG; `marker` makes distinct bytes. */
export function png(marker: number, width = 8, height = 8): Uint8Array {
  const raw = new Uint8Array(height * (Math.ceil(width / 8) + 1))
  return Uint8Array.from([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...chunk('IHDR', [...u32(width), ...u32(height), 1, 0, 0, 0, 0]),
    ...chunk('tEXt', [...Buffer.from(`marker\0${marker}`, 'ascii')]),
    ...chunk('IDAT', [...deflateSync(raw)]),
    ...chunk('IEND', []),
  ])
}

const mediaBinding: W.BindingRef = {
  bindingId: 'media-binding',
  providerId: 'fixture/media',
  contract: 'agh.media',
  logicalName: 'media',
}
const stateBinding: W.BindingRef = {
  bindingId: 'state-binding',
  providerId: 'fixture/state',
  contract: 'agh.state',
  logicalName: 'state',
}
const modelBinding: W.BindingRef = {
  bindingId: 'model-binding',
  providerId: 'fixture/model',
  contract: 'agh.model',
  logicalName: 'model',
}
const SCHEMA = local('fixture/schema@1')
const NATIVE = local('agh.media/transform-native@1')
const CONVERT = local('agh.media/transform-image-to-text@1')
const PARAMETERS = local('agh.media/parameters@1')
const LIMITS = {
  maxManifestEntries: 8,
  maxSelectedImages: 8,
  maxSelectedBlocks: 16,
  maxBytesPerImage: 4096,
  maxDimensionPerImage: 1456,
  maxPixelsPerImage: 10_000_000,
  maxSelectedBytes: 16_384,
  maxSelectedPixels: 10_000_000,
}
const features = (image: boolean): W.ModelFeatures => ({
  input: image ? ['text', 'image'] : ['text'],
  output: ['text'],
  tools: false,
  structuredOutput: false,
  streaming: true,
})
const route: W.ModelRouteSnapshot = {
  routeId: 'vision-route',
  routeRevision: 1,
  adapter: {
    bindingId: 'adapter',
    providerId: 'fixture/adapter',
    contract: 'agh.model-adapter',
    logicalName: 'a',
  },
  model: 'vision-model',
  endpointRef: 'vision-endpoint',
  catalogRevision: 1,
  features: features(true),
  priceVersion: 'price-1',
  credentialAudience: 'vision-endpoint',
  credentialBinding: null,
}
const VISION_TEXT = 'A dialog with a Save button'
const VISION_USAGE: W.UsageFactRef[] = [
  { authorityId: 'usage-authority', usageId: 'vision-attempt:model', digest: digestOf({ usage: 1 }) },
]
const future = () => new Date(Date.now() + 60_000).toISOString()

export async function createMediaContractFixture(
  make: MediaFactoryMaker,
  world: MediaWorld = newWorld(),
): Promise<MediaContractFixture> {
  const markers = [1, 2]
  for (const marker of markers) {
    const bytes = png(marker)
    world.bytes.set(sha(bytes), bytes)
  }
  const blobOf = (marker: number): W.BlobRef => {
    const bytes = png(marker)
    return {
      authorityId: 'blob-authority',
      blobId: `blob-${marker}`,
      digest: sha(bytes),
      bytes: bytes.length,
      mediaType: 'image/png',
      pinId: `pin-${marker}`,
    }
  }
  const sourceRefs: W.PublicRef[] = markers.map((m) => ({ kind: 'blob', value: blobOf(m) }))
  const sourceDigest = digestOf({ kind: 'agh.media/sources@1', sources: markers.map(blobOf) })
  const plan = (kind: 'native' | 'convert'): W.MediaPlan => ({
    key: `media:${kind}`,
    sourceRefs,
    sourceDigest,
    transformSchema: kind === 'native' ? NATIVE : CONVERT,
    parameters: pack(PARAMETERS, {
      kind: 'agh.media/parameters@1',
      slot: 'image',
      maxEdge: 1456,
      maxOutputTokens: 512,
      failurePolicy: 'fail',
      allowConversion: true,
      nodes: [1, 2],
      limits: LIMITS,
    }),
    targetFeatures: features(kind === 'native'),
    provider: mediaBinding,
  })
  const plans = { native: plan('native'), convert: plan('convert') }
  const abort = new AbortController()
  const wire = (deadline = future()): W.CallContextWire => ({
    principalRef: 'principal',
    scope: { kind: 'runtime', installationId: 'inst', runtimeId: 'rt' },
    bindingId: mediaBinding.bindingId,
    invocationId: 'invocation',
    deadline,
    traceRef: 'trace',
    authorizationRef: 'authorization',
  })
  const call: CallContext = { ...wire(), signal: abort.signal }
  const frame = (p: W.MediaPlan): ActionFrame => {
    const input = pack(RuntimeMethodSchemaRefs['agh.media'].prepare.input, p)
    return {
      actionId: 'media-parent',
      parentActionId: null,
      runId: 'run',
      bindingId: mediaBinding.bindingId,
      method: 'prepare',
      input,
      inputDigest: input.kind === 'inline' ? input.digest : '',
      attemptId: 'attempt',
      attemptNumber: 1,
      invocationId: 'invocation',
      requestIdentity: null,
      providerRevision: 0,
      continuation: null,
      signals: { items: [], snapshot: 's', nextCursor: null, complete: true },
      receipts: { items: [], snapshot: 's', nextCursor: null, complete: true },
      signalHighWater: 0,
      snapshot: 'snap',
      observedAt: new Date().toISOString(),
      context: wire(),
      actionTimebox: { defaultTimeoutMs: 60_000, maxDeadline: future() },
    }
  }
  const deployment: MediaContractDeployment = {
    binding: mediaBinding,
    packageDigest: 'f'.repeat(64),
    configSchema: SCHEMA,
    requires: [],
    state: stateBinding,
    limits: LIMITS,
    sources: {
      async open(ref) {
        const denied: Outcome<never> = {
          ok: false,
          error: {
            code: 'denied',
            detailCode: 'fixture',
            message: 'denied',
            diagnosticId: 'fixture',
            retryAdvice: { kind: 'never' },
          },
        }
        if (!world.allowed.value || ref.kind !== 'blob') return denied
        const bytes = world.bytes.get(ref.value.digest)
        return bytes
          ? {
              ok: true,
              value: { blob: ref.value, bytes, version: 'v1', trust: 'external', sourceTool: 'computer_use' },
            }
          : denied
      },
      epoch: () => (world.allowed.value ? 'epoch-live' : 'epoch-revoked'),
    },
    vision: {
      async resolve() {
        return {
          ok: true,
          value: {
            model: modelBinding,
            route,
            generation: { maxOutputTokens: 256, thinking: null },
            sessionParameterRef: {
              authorityId: 'cfg',
              recordId: 'p',
              recordRevision: 1,
              schema: SCHEMA,
              digest: digestOf({}),
            },
            credentialRef: null,
            parserVersion: '1',
            viewSchema: SCHEMA,
          },
        }
      },
    },
    authorize: () => world.allowed.value,
  }
  const ports: LoopReadPorts = {
    async query(request) {
      const input =
        request.input.kind === 'inline'
          ? (request.input.value as { actionId: string; sourceReceiptId: string })
          : null
      const view = input ? world.receipts.get(`${input.actionId}:${input.sourceReceiptId}`) : undefined
      const value = view
        ? {
            actionId: view.actionId,
            sourceReceiptId: view.sourceReceiptId,
            revision: 1,
            state: 'ready',
            stageActionId: null,
            registrationDigest: null,
            result: view,
            uiResult: null,
            publishedByCommitId: 'commit',
          }
        : null
      return {
        ok: true,
        value: {
          kind: 'value',
          output: pack(RuntimeMethodSchemaRefs['agh.state'].probeActionResult.output, value),
          snapshot: 's',
        },
      }
    },
    async compute() {
      world.counters.computes += 1
      world.counters.preparedIds += 1
      return {
        ok: true,
        value: pack(RuntimeMethodSchemaRefs['agh.model'].prepare.output, {
          preparedRef: pack(SCHEMA, { preparedId: `prepared-${world.counters.preparedIds}` }),
          targetSnapshot: route,
          inputDigest: digestOf({ n: world.counters.preparedIds }),
          estimatedUnits: [],
          mediaPlanRefs: [],
        }),
      }
    },
    async resolveData() {
      return {
        ok: false,
        error: {
          code: 'incompatible',
          detailCode: 'fixture',
          message: '',
          diagnosticId: 'fixture',
          retryAdvice: { kind: 'never' },
        },
      }
    },
    prepare(spec) {
      world.counters.children += 1
      return {
        ok: true,
        value: { ...spec, obligation: 'mandatory', intentFingerprint: digestOf(spec) } as W.PreparedAction,
      }
    },
  }
  const factory = make(deployment)
  const scope: ActionHandlerScope = {
    instanceId: 'instance',
    actionId: 'media-parent',
    runId: 'run',
    bindingId: mediaBinding.bindingId,
    scope: wire().scope,
    signal: abort.signal,
  }
  return {
    factory,
    configuration: pack(SCHEMA, {}),
    dependencies: {} as ScopedDependencies,
    factoryContext: {
      bindingId: mediaBinding.bindingId,
      instanceId: 'instance',
      signal: abort.signal,
    } as unknown as FactoryContext,
    call,
    scope,
    ports,
    plans,
    visionText: VISION_TEXT,
    visionUsage: VISION_USAGE,
    nativeFrame: frame(plans.native),
    convertFrame: frame(plans.convert),
    foreignFrame: frame({ ...plans.native, provider: { ...mediaBinding, bindingId: 'someone-else' } }),
    async dispatch(child: PreparedAction) {
      world.counters.vision += 1
      const output: W.ModelOutput = {
        outputRef: pack(SCHEMA, {
          content: [{ type: 'text', text: VISION_TEXT }],
          structured: { thinking: '', toolCalls: [] },
        }),
        finishReason: 'stop',
        usageFactRefs: VISION_USAGE,
        providerReceipt: null,
        actualModel: 'vision-model',
      }
      const view: W.ActionResultView = {
        receiptId: 'vision-receipt',
        actionId: 'vision-child',
        attemptId: 'vision-attempt',
        bindingId: child.target.bindingId,
        inputDigest: child.input.kind === 'inline' ? child.input.digest : '',
        outcome: 'succeeded',
        result: pack(RuntimeMethodSchemaRefs['agh.model'].infer.output, output),
        externalRequests: [],
        usageRefs: ['vision-attempt:model'],
        references: [],
        provenance: { sourceRefs: [], producer: modelBinding, trustLabels: [] },
        completedAt: new Date().toISOString(),
        visibility: 'ready',
        viewId: 'vision-view',
        sourceReceiptId: 'vision-receipt',
        hookResultSetRef: null,
      }
      world.receipts.set(`${view.actionId}:${view.sourceReceiptId}`, view)
      return { actionId: view.actionId, receiptId: view.receiptId, outcome: 'succeeded' }
    },
    visionRequests: () => world.counters.vision,
    computeCalls: () => world.counters.computes,
    childrenPrepared: () => world.counters.children,
    async revoke() {
      world.allowed.value = false
    },
    restart: () => createMediaContractFixture(make, world),
    async close() {
      abort.abort()
    },
  }
}
