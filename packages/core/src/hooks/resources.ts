import type { ResourceEntry } from '@agnes/extension-api'
import type { Actor } from '@agnes/protocol'
import type { SeamRuntime } from '../effects/wrap.js'
import type { RegisteredResource } from '../registry/resources.js'
import type { ContextResult } from '../request/transforms.js'
import type { DispatchContext, HookEngine } from './engine.js'

export type ResourceDiscoveryInputs = {
  registered(): readonly RegisteredResource[]
  actor(): Actor
  cwd(): string
  principals: Pick<SeamRuntime, 'authorize'>
}
export type ResourceDiscovery = {
  resources: ResourceEntry[]
  contributions: Array<{ ext: string; result: ContextResult }>
}

/** Author handlers add candidates; only the principals seam decides what may be disclosed. */
export async function discoverResources(
  engine: HookEngine,
  input: ResourceDiscoveryInputs,
  context: DispatchContext,
): Promise<ResourceDiscovery> {
  const actor = structuredClone(input.actor()),
    cwd = input.cwd()
  const candidates = input.registered().map(({ entry }) => structuredClone(entry))
  const contributions: ResourceDiscovery['contributions'] = []
  await engine.dispatch('resources_discover', () => ({ actor, cwd, registered: candidates }), context, {
    accept: (value, source) => {
      if (value.resources) candidates.push(...value.resources)
      if (value.additionalContext !== undefined)
        contributions.push({ ext: source, result: { additionalContext: value.additionalContext } })
    },
  })
  const resources: ResourceEntry[] = []
  for (const entry of candidates) {
    if (context.signal.aborted) break
    let cancel = () => {}
    const cancelled = new Promise<undefined>((resolve) => {
      cancel = () => resolve(undefined)
      context.signal.addEventListener('abort', cancel, { once: true })
    })
    try {
      const decision = await Promise.race([
        input.principals.authorize(structuredClone(actor), 'discover', { kind: entry.kind, id: entry.id }),
        cancelled,
      ])
      if (!context.signal.aborted && decision?.effect === 'allow') resources.push(entry)
    } catch {
      /* An unavailable authorizer never grants discovery. */
    } finally {
      context.signal.removeEventListener('abort', cancel)
    }
  }
  // A cancelled request cannot publish a partial disclosure or injected context.
  return context.signal.aborted ? { resources: [], contributions: [] } : { resources, contributions }
}
