import type {
  RendererDefinition,
  UIRegistry,
  UIRegistryFactory,
  UIRegistryHost,
} from '@agnes/extension-api/client'

// Deliberately broken registries for the conformance tests. The client processes `recover` starts
// import them too, so each is a named export that changes a factory.

/** Replaces some registry methods; the replacements reach the real registry through `registry`. */
const wrap =
  (change: (registry: UIRegistry, host: UIRegistryHost) => Partial<UIRegistry>) =>
  (factory: UIRegistryFactory): UIRegistryFactory =>
  (host) => {
    const made = factory(host)
    return made.ok ? { ok: true, value: { ...made.value, ...change(made.value, host) } } : made
  }

export const acceptsConflicts = wrap((registry) => ({
  register(definition) {
    const registered = registry.register(definition)
    if (registered.ok || registered.error.code !== 'conflict') return registered
    return {
      ok: true,
      value: { id: definition.descriptor.id, ownerToken: 'unregistered', dispose: async () => {} },
    }
  },
}))

// Dispose looks the registration up by descriptor id, so a stale one removes whichever holds the id now.
export const staleDisposeRemovesNewer = wrap((registry) => {
  const latest = new Map<string, { dispose(): Promise<void> }>()
  return {
    register(definition) {
      const registered = registry.register(definition)
      if (!registered.ok) return registered
      const { id } = definition.descriptor
      latest.set(id, registered.value)
      return {
        ok: true,
        value: {
          ...registered.value,
          dispose: async () => {
            await latest.get(id)?.dispose()
          },
        },
      }
    },
  }
})

export const hostRefusalBecomesFallback = wrap((registry) => ({
  resolve(request) {
    const resolved = registry.resolve(request)
    if (resolved.ok || resolved.error.code === 'invalid_input') return resolved
    return { ok: true, value: { kind: 'fallback', reason: 'renderer unavailable' } }
  },
}))

// Serves the latest registered renderer for the render key and target, whatever revisions it covers,
// so the selection follows registration order.
export const latestRegisteredWins = wrap((registry, host) => {
  const active = new Set<RendererDefinition>()
  return {
    register(definition) {
      const registered = registry.register(definition)
      if (!registered.ok) return registered
      active.add(definition)
      const { dispose } = registered.value
      return {
        ok: true,
        value: {
          ...registered.value,
          dispose: async () => {
            active.delete(definition)
            await dispose()
          },
        },
      }
    },
    resolve(request) {
      const found = [...active]
        .reverse()
        .find(
          ({ descriptor }) =>
            descriptor.renderKey === request.renderKey && descriptor.targets.includes(request.target),
        )
      if (found === undefined) return registry.resolve(request)
      const bound = host.bindRenderer(found)
      if (!bound.ok) return bound
      return { ok: true, value: { kind: 'matched', descriptor: found.descriptor, handle: bound.value } }
    },
  }
})
