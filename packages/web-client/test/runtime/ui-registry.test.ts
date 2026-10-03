import { Context } from '@agnes/cordis'
import type {
  RendererDefinition,
  RendererDescriptor,
  RendererHandle,
  UIRegistry,
} from '@agnes/extension-api/client'
import { SlotCore } from '@agnes/web-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '../../src/index.js'
import { SlotRegistry } from '../../src/registry.js'
import { createUIRegistry } from '../../src/runtime/providers/ui-registry.js'

// The shared contract cases judge the registry itself; these pin what the slot ledger under it adds.

const handle: RendererHandle = {
  id: 'handle-1',
  ownerToken: 'owner-1',
  present: () => ({
    ok: false,
    error: {
      code: 'denied',
      detailCode: 'not_presented',
      message: 'not presented',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'ui-registry-test',
    },
  }),
  dispose: async () => {},
}

function open(): UIRegistry {
  const made = createUIRegistry({ bindRenderer: () => ({ ok: true, value: handle }) })
  if (!made.ok) throw new Error(made.error.code)
  return made.value
}

const descriptor = (targets: RendererDescriptor['targets']): RendererDescriptor => ({
  id: 'acme.card',
  packageDigest: 'c'.repeat(64),
  renderKey: 'card',
  targets,
  viewSchemaRanges: [{ typeId: 'acme.card/view@1', minRevision: 1, maxRevision: 3 }],
  requiredFeatures: [],
  optionalFeatures: [],
  scope: 'view',
  entry: './card.js',
})

// Presents on every target, so one definition can declare all of them.
const everywhere = (targets: RendererDescriptor['targets']) =>
  ({
    descriptor: descriptor(targets),
    component: () => null,
    format: handle.present,
    encode: handle.present,
  }) as unknown as RendererDefinition

const kinds = (registry: UIRegistry, targets: RendererDescriptor['targets']) =>
  targets.map((target) => {
    const resolved = registry.resolve({
      renderKey: 'card',
      viewSchema: { typeId: 'acme.card/view@1', revision: 2, digest: 'c'.repeat(64) },
      target,
      requiredFeatures: [],
    })
    return resolved.ok ? resolved.value.kind : resolved.error.code
  })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('web client ui registry over a private slot ledger', () => {
  it('serves every declared target and removes all of them on dispose', async () => {
    const registry = open()
    const targets: RendererDescriptor['targets'] = ['web', 'tui', 'im', 'sdk']
    const registered = registry.register(everywhere(targets))
    if (!registered.ok) throw new Error(registered.error.code)
    expect(kinds(registry, targets)).toEqual(['matched', 'matched', 'matched', 'matched'])
    await registered.value.dispose()
    expect(kinds(registry, targets)).toEqual(['fallback', 'fallback', 'fallback', 'fallback'])
  })

  it('refuses a renderer the ledger throws on and keeps none of its earlier targets', () => {
    const registry = open()
    const register = SlotCore.prototype.register
    vi.spyOn(SlotCore.prototype, 'register')
      .mockImplementationOnce(function (this: SlotCore, ...args) {
        return register.apply(this, args)
      })
      .mockImplementationOnce(() => {
        throw new Error('the cell is taken')
      })
    const refused = registry.register(everywhere(['web', 'tui']))
    expect(refused.ok ? 'ok' : refused.error.code).toBe('conflict')
    expect(kinds(registry, ['web', 'tui'])).toEqual(['fallback', 'fallback'])
    vi.restoreAllMocks()
    expect(registry.register(everywhere(['web', 'tui'])).ok).toBe(true)
  })

  it("leaves the app's slot registry and its built-in slots untouched", async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry)
    const slots = (ctx as unknown as ClientContext).slots as SlotRegistry
    const before = slots.core.snapshot()
    const registry = open()
    expect(registry.register(everywhere(['web'])).ok).toBe(true)
    expect(kinds(registry, ['web'])).toEqual(['matched'])
    expect(slots.core.snapshot()).toEqual(before)
    expect(slots.core.spec('web')).toBeUndefined()
  })
})
