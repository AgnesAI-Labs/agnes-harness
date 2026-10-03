// The web client's default UI registry. Registered renderers live in a slot ledger of its own, never
// the app's slot registry, so the built-in slots keep their priority, shadowing and abdication rules.
// The ledger has one keyed slot per target and a registration adds one entry to each slot it declares.
// The registry leases every handle from the client host; it never builds a renderer context or a handle.
import type {
  RendererDefinition,
  RendererDescriptor,
  RuntimeError,
  UIRegistry,
  UIRegistryFactory,
} from '@agnes/extension-api/client'
import { SlotCore } from '@agnes/web-slots'

type Request = Parameters<UIRegistry['resolve']>[0]
type Target = Request['target']
type Registered = { readonly definition: RendererDefinition; readonly descriptor: RendererDescriptor }

const TARGETS: readonly Target[] = ['web', 'tui', 'im', 'sdk']
const SCOPES: readonly unknown[] = ['client', 'client-session', 'view']
const DESCRIPTOR_KEYS = [
  'id',
  'packageDigest',
  'renderKey',
  'targets',
  'viewSchemaRanges',
  'requiredFeatures',
  'optionalFeatures',
  'scope',
  'entry',
]
const DIGEST = /^[a-f0-9]{64}$/
const TYPE_ID =
  /^(?:[a-z][a-z0-9.-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)\/[a-zA-Z0-9._/-]+@[1-9][0-9]*$/
const ENTRY = /^\.\/(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$))(?!.*\/\/)[^\\]+$/

const refuse = (code: 'invalid_input' | 'conflict', message: string): { ok: false; error: RuntimeError } => ({
  ok: false,
  error: {
    code,
    detailCode: code === 'conflict' ? 'renderer_conflict' : 'invalid_request',
    message,
    retryAdvice: { kind: 'never' },
    diagnosticId: 'web-client-ui-registry',
  },
})

/** Whether `text` has a control character below space, or DEL when `del` is set. */
const control = (text: string, del: boolean) => [...text].some((c) => c <= '\x1f' || (del && c === '\x7f'))
const name = (value: unknown) =>
  typeof value === 'string' && value.length >= 1 && value.length <= 256 && !control(value, true)
const list = (value: unknown, min: number, max: number, item: (entry: unknown) => boolean) =>
  Array.isArray(value) && value.length >= min && value.length <= max && value.every(item)
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1
const validRange = (value: unknown) =>
  exact(value, ['typeId', 'minRevision', 'maxRevision']) &&
  typeof value.typeId === 'string' &&
  value.typeId.length <= 256 &&
  TYPE_ID.test(value.typeId) &&
  revision(value.minRevision) &&
  revision(value.maxRevision) &&
  value.minRevision <= value.maxRevision

/**
 * The RendererDescriptor schema with every revision range in order. Checked by hand: the client entry
 * of the extension API carries types only, and this package takes no runtime protocol validator.
 */
function validDescriptor(value: unknown): value is RendererDescriptor {
  return (
    exact(value, DESCRIPTOR_KEYS) &&
    name(value.id) &&
    typeof value.packageDigest === 'string' &&
    DIGEST.test(value.packageDigest) &&
    name(value.renderKey) &&
    list(value.targets, 1, 4, (target) => TARGETS.includes(target as Target)) &&
    list(value.viewSchemaRanges, 1, 64, validRange) &&
    list(value.requiredFeatures, 0, 64, name) &&
    list(value.optionalFeatures, 0, 64, name) &&
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
    TARGETS.includes(request.target as Target) &&
    typeof schema?.typeId === 'string' &&
    Number.isInteger(schema.revision) &&
    Array.isArray(request.requiredFeatures) &&
    request.requiredFeatures.every((feature) => typeof feature === 'string')
  )
}

/** Web presents through a component, the text targets through format, IM also through encode. */
function serves(definition: RendererDefinition, target: Target): boolean {
  const has = (part: string) => typeof (definition as unknown as Record<string, unknown>)[part] === 'function'
  return target === 'web' ? has('component') : has('format') && (target !== 'im' || has('encode'))
}

/** Same render key and overlapping revisions of one view type; the caller checks for a shared target. */
const overlaps = (left: RendererDescriptor, right: RendererDescriptor) =>
  left.renderKey === right.renderKey &&
  left.viewSchemaRanges.some((a) =>
    right.viewSchemaRanges.some(
      (b) => a.typeId === b.typeId && a.minRevision <= b.maxRevision && b.minRevision <= a.maxRevision,
    ),
  )

export const createUIRegistry: UIRegistryFactory = (host) => {
  if (typeof host?.bindRenderer !== 'function') return refuse('invalid_input', 'the host has no bindRenderer')
  const slots = new SlotCore()
  for (const target of TARGETS) slots.declare(target, { kind: 'keyed', scope: 'root' })
  const registered = (target: Target) => slots.entries(target).map((entry) => entry.component as Registered)
  let issued = 0
  return {
    ok: true,
    value: {
      register(definition) {
        if (!validDescriptor(definition?.descriptor))
          return refuse('invalid_input', 'the descriptor is invalid')
        const descriptor = structuredClone(definition.descriptor)
        const targets = [...new Set(descriptor.targets)]
        if (!targets.every((target) => serves(definition, target)))
          return refuse('invalid_input', 'the definition cannot present a declared target')
        // ponytail: same-cell renderers are refused, so at most one matches and resolve needs no selection.
        // Selection by profile or client redirect is added when the server-chosen selection reaches the client.
        for (const target of TARGETS) {
          for (const { descriptor: other } of registered(target)) {
            if (other.id === descriptor.id || (targets.includes(target) && overlaps(other, descriptor)))
              return refuse('conflict', `the renderer conflicts with ${other.id}`)
          }
        }
        // Keyed by descriptor id: one render key may hold several renderers for disjoint revisions.
        const removers: (() => void)[] = []
        try {
          for (const target of targets)
            removers.push(slots.register({ name: target, key: descriptor.id }, { definition, descriptor }))
        } catch {
          for (const remove of removers) remove()
          return refuse('conflict', 'the slot ledger refused the renderer')
        }
        issued += 1
        return {
          ok: true,
          value: {
            id: descriptor.id,
            ownerToken: `web-client-renderer-${issued}`,
            // Each remover takes only its own entry, once, so a stale or repeated dispose is harmless.
            dispose: async () => {
              for (const remove of removers) remove()
            },
          },
        }
      },
      resolve(request) {
        if (!validRequest(request)) return refuse('invalid_input', 'the resolve request is malformed')
        const { renderKey, viewSchema, target, requiredFeatures } = request
        const found = registered(target).find(
          ({ descriptor }) =>
            descriptor.renderKey === renderKey &&
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
