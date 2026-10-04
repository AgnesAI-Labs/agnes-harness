import type { RendererDescriptor, RendererHandle, UIRegistry } from '@agnes/extension-api/client'
import { encodeForChannel, formatDomainView } from '@agnes/sdk/runtime'
import { describe, expect, it } from 'vitest'
import { createDefaultRenderer } from '../../src/runtime/providers/renderer.js'
import { createUIRegistry } from '../../src/runtime/providers/ui-registry.js'
import { GenericDomainView } from '../../src/runtime/renderers/generic.js'

// The shared contract cases judge the default renderer through the client host; these pin that it is the
// built-in presentation under the descriptor a catalog declares, and that the default registry takes it.

const descriptor: RendererDescriptor = {
  id: 'acme.default-card',
  packageDigest: 'c'.repeat(64),
  renderKey: 'card',
  targets: ['web', 'tui', 'im', 'sdk'],
  viewSchemaRanges: [{ typeId: 'acme.card/view@1', minRevision: 1, maxRevision: 3 }],
  requiredFeatures: [],
  optionalFeatures: [],
  scope: 'view',
  entry: './card.js',
}

const handle = { id: 'handle-1', ownerToken: 'owner-1' } as RendererHandle

describe('web client default renderer', () => {
  it('presents every target with the built-in presentation and registers for each', () => {
    const definition = createDefaultRenderer(descriptor)
    expect(definition).toEqual({
      descriptor,
      component: GenericDomainView,
      format: formatDomainView,
      encode: encodeForChannel,
    })
    const made = createUIRegistry({ bindRenderer: () => ({ ok: true, value: handle }) })
    if (!made.ok) throw new Error(made.error.code)
    const registry: UIRegistry = made.value
    expect(registry.register(definition).ok).toBe(true)
    expect(
      descriptor.targets.map((target) => {
        const resolved = registry.resolve({
          renderKey: 'card',
          viewSchema: { typeId: 'acme.card/view@1', revision: 2, digest: 'c'.repeat(64) },
          target,
          requiredFeatures: [],
        })
        return resolved.ok ? resolved.value.kind : resolved.error.code
      }),
    ).toEqual(['matched', 'matched', 'matched', 'matched'])
  })
})
