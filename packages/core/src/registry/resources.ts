import { extEventType, type ResourceEntry } from '@agnes/extension-api'
import { inspectJsonData, validateAgainst } from '@agnes/protocol'
import { ResourceEntry as ResourceSchema } from '@agnes/protocol/gen/hooks'
import { CoreError, type Disposer } from '../types.js'
import { OwnedRegistryTable } from './owner-batch.js'
import type { ToolSource } from './tools.js'

export type RegisteredResource = Readonly<{ entry: Readonly<ResourceEntry>; meta: Readonly<ToolSource> }>

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Registration is not disclosure: callers must authorize every resource before exposing it. */
export class ResourceRegistry {
  private readonly entries = new OwnedRegistryTable<RegisteredResource>()

  register(entry: ResourceEntry, meta: ToolSource): Disposer {
    if (!['builtin', 'trusted'].includes(meta.trust))
      throw new CoreError('E_ENVELOPE', 'invalid resource registration')
    extEventType(meta.source, 'resource')
    // Resource schemas have no event-payload byte cap; retain the shared depth/JSON safety checks.
    const data = inspectJsonData(entry, Number.MAX_SAFE_INTEGER)
    if (!data.ok || !validateAgainst(ResourceSchema, data.value).ok)
      throw new CoreError('E_ENVELOPE', 'invalid resource registration')
    const registration = Object.freeze({
      entry: freeze(data.value as ResourceEntry),
      meta: Object.freeze({ ...meta }),
    })
    return this.entries.add(meta.source, entry.id, registration)
  }

  prepareOwnerReplacement(owner: string, candidate: ResourceRegistry) {
    return this.entries.prepare(owner, candidate.entries)
  }

  registrations(source: string): string[] {
    return this.entries
      .values()
      .filter((record) => record.meta.source === source)
      .map((record) => `resource:${record.entry.id}`)
  }

  snapshot(): readonly RegisteredResource[] {
    return Object.freeze(this.entries.values())
  }
}
