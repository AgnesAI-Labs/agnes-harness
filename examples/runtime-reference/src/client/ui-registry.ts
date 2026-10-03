// The browser entry reaches no package, not even for types, so the shapes this registry reads are
// mirrored here. The Node binding assigns the factory to UIRegistryFactory, which keeps them in step.
type Target = 'web' | 'tui' | 'im' | 'sdk'

interface Descriptor {
  id: string
  packageDigest: string
  renderKey: string
  targets: Target[]
  viewSchemaRanges: { typeId: string; minRevision: number; maxRevision: number }[]
  requiredFeatures: string[]
  optionalFeatures: string[]
  scope: 'client' | 'client-session' | 'view'
  entry: string
}

interface Request {
  renderKey: string
  viewSchema: { typeId: string; revision: number }
  target: Target
  requiredFeatures: string[]
}

type Outcome<T, E> = { ok: true; value: T } | { ok: false; error: E }

interface Refusal {
  code: 'invalid_input' | 'conflict'
  detailCode: string
  message: string
  retryAdvice: { kind: 'never' }
  diagnosticId: string
}

interface Registry<D, H, E> {
  register(definition: D): Outcome<{ id: string; ownerToken: string; dispose(): Promise<void> }, Refusal>
  resolve(
    request: Request,
  ): Outcome<
    { kind: 'matched'; descriptor: Descriptor; handle: H } | { kind: 'fallback'; reason: string },
    E | Refusal
  >
}

const refuse = (code: Refusal['code'], message: string): { ok: false; error: Refusal } => ({
  ok: false,
  error: {
    code,
    detailCode: code === 'conflict' ? 'renderer_conflict' : 'invalid_request',
    message,
    retryAdvice: { kind: 'never' },
    diagnosticId: 'reference-ui-registry',
  },
})

const TARGETS: readonly unknown[] = ['web', 'tui', 'im', 'sdk']
const SCOPES: readonly unknown[] = ['client', 'client-session', 'view']
const DIGEST = /^[a-f0-9]{64}$/
const TYPE_ID =
  /^(?:[a-z][a-z0-9.-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)\/[a-zA-Z0-9._/-]+@[1-9][0-9]*$/
const ENTRY = /^\.\/(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$))(?!.*\/\/)[^\\]+$/

const control = (text: string, del: boolean) => [...text].some((c) => c <= '\x1f' || (del && c === '\x7f'))
const name = (value: unknown, max: number) =>
  typeof value === 'string' && value.length >= 1 && value.length <= max && !control(value, true)
const list = (value: unknown, min: number, max: number, item: (entry: unknown) => boolean) =>
  Array.isArray(value) && value.length >= min && value.length <= max && value.every(item)
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))
const typeId = (value: unknown) => typeof value === 'string' && value.length <= 256 && TYPE_ID.test(value)
const revision = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 1

/** The RendererDescriptor schema, checked by hand because the protocol validator is not browser-safe. */
function validDescriptor(value: unknown): value is Descriptor {
  return (
    exact(value, [
      'id',
      'packageDigest',
      'renderKey',
      'targets',
      'viewSchemaRanges',
      'requiredFeatures',
      'optionalFeatures',
      'scope',
      'entry',
    ]) &&
    name(value.id, 256) &&
    typeof value.packageDigest === 'string' &&
    DIGEST.test(value.packageDigest) &&
    name(value.renderKey, 256) &&
    list(value.targets, 1, 4, (target) => TARGETS.includes(target)) &&
    list(
      value.viewSchemaRanges,
      1,
      64,
      (range) =>
        exact(range, ['typeId', 'minRevision', 'maxRevision']) &&
        typeId(range.typeId) &&
        revision(range.minRevision) &&
        revision(range.maxRevision),
    ) &&
    list(value.requiredFeatures, 0, 64, (feature) => name(feature, 256)) &&
    list(value.optionalFeatures, 0, 64, (feature) => name(feature, 256)) &&
    SCOPES.includes(value.scope) &&
    typeof value.entry === 'string' &&
    value.entry.length <= 1024 &&
    ENTRY.test(value.entry) &&
    !control(value.entry, false)
  )
}

function validRequest(value: unknown): value is Request {
  const request = value as Partial<Record<keyof Request, unknown>> | null
  const schema = request?.viewSchema as Partial<Record<'typeId' | 'revision', unknown>> | null | undefined
  return (
    typeof request?.renderKey === 'string' &&
    TARGETS.includes(request.target) &&
    typeof schema?.typeId === 'string' &&
    Number.isInteger(schema.revision) &&
    Array.isArray(request.requiredFeatures) &&
    request.requiredFeatures.every((feature) => typeof feature === 'string')
  )
}

/** Whether the definition can present on `target`: web needs a component, IM format and encode, the rest format. */
function serves(definition: object, target: Target): boolean {
  const parts = definition as Record<string, unknown>
  const has = (part: string) => typeof parts[part] === 'function'
  if (target === 'web') return has('component')
  return has('format') && (target !== 'im' || has('encode'))
}

/** Same render key, a shared target and overlapping revisions of one view type. */
const sameCell = (left: Descriptor, right: Descriptor) =>
  left.renderKey === right.renderKey &&
  left.targets.some((target) => right.targets.includes(target)) &&
  left.viewSchemaRanges.some((a) =>
    right.viewSchemaRanges.some(
      (b) => a.typeId === b.typeId && a.minRevision <= b.maxRevision && b.minRevision <= a.maxRevision,
    ),
  )

/**
 * Reference UI registry. It keeps the registered renderers and, for the one that matches a request,
 * leases a handle from the host with the registered definition. It never builds a renderer context or
 * a handle itself.
 */
export function createReferenceUIRegistry<D extends { descriptor: Descriptor }, H, E>(host: {
  bindRenderer(definition: D): Outcome<H, E>
}): Outcome<Registry<D, H, E>, Refusal> {
  if (typeof host?.bindRenderer !== 'function') return refuse('invalid_input', 'the host has no bindRenderer')
  // Keyed by owner token, so a stale dispose can only remove its own registration.
  const active = new Map<string, { definition: D; descriptor: Descriptor }>()
  let issued = 0
  return {
    ok: true,
    value: {
      register(definition) {
        if (!validDescriptor(definition?.descriptor))
          return refuse('invalid_input', 'the descriptor is invalid')
        const descriptor = structuredClone(definition.descriptor)
        if (descriptor.viewSchemaRanges.some((range) => range.minRevision > range.maxRevision))
          return refuse('invalid_input', 'a revision range ends before it starts')
        if (!descriptor.targets.every((target) => serves(definition, target)))
          return refuse('invalid_input', 'the definition cannot present a declared target')
        // ponytail: same-cell renderers are refused, so at most one matches and resolve needs no selection.
        // Selection by profile or client redirect is added when the server-chosen selection reaches the client.
        for (const entry of active.values()) {
          if (entry.descriptor.id === descriptor.id || sameCell(entry.descriptor, descriptor))
            return refuse('conflict', `the renderer conflicts with ${entry.descriptor.id}`)
        }
        issued += 1
        const ownerToken = `reference-renderer-${issued}`
        active.set(ownerToken, { definition, descriptor })
        return {
          ok: true,
          value: {
            id: descriptor.id,
            ownerToken,
            dispose: async () => {
              active.delete(ownerToken)
            },
          },
        }
      },
      resolve(request) {
        if (!validRequest(request)) return refuse('invalid_input', 'the resolve request is malformed')
        const { renderKey, viewSchema, target, requiredFeatures } = request
        const found = [...active.values()].find(
          ({ descriptor }) =>
            descriptor.renderKey === renderKey &&
            descriptor.targets.includes(target) &&
            descriptor.viewSchemaRanges.some(
              (range) =>
                range.typeId === viewSchema.typeId &&
                range.minRevision <= viewSchema.revision &&
                viewSchema.revision <= range.maxRevision,
            ) &&
            requiredFeatures.every(
              (feature) =>
                descriptor.requiredFeatures.includes(feature) ||
                descriptor.optionalFeatures.includes(feature),
            ),
        )
        if (found === undefined)
          return { ok: true, value: { kind: 'fallback', reason: 'no_matching_renderer' } }
        const bound = host.bindRenderer(found.definition)
        if (!bound.ok) return bound
        return {
          ok: true,
          value: { kind: 'matched', descriptor: structuredClone(found.descriptor), handle: bound.value },
        }
      },
    },
  }
}
