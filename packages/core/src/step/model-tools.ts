import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import type { ModelRecord, Provider } from '@agnes/protocol'
import { validateAgainst } from '@agnes/protocol'
import { ModelRecord as ModelRecordSchema } from '@agnes/protocol/gen/model'
import type { RegisteredTool, RegistrySnapshot } from '../registry/tools.js'

export type ModelInput = readonly ('text' | 'image')[]

/** Resolve one exact validated model snapshot. Catalogue ambiguity exposes no capabilities. */
export function resolvedModelRecord(
  provider: Pick<Provider, 'models'>,
  target: { route: string; model: string },
): ModelRecord | undefined {
  try {
    const raw: unknown = provider.models()
    if (!Array.isArray(raw) || raw.length > 10_000) return undefined
    const matches: ModelRecord[] = []
    for (const value of raw) {
      const checked = validateAgainst<ModelRecord>(ModelRecordSchema, value)
      if (!checked.ok) return undefined
      if (checked.value.route === target.route && checked.value.id === target.model)
        matches.push(checked.value)
    }
    const selected = matches.length === 1 ? matches[0] : undefined
    return selected ? structuredClone(selected) : undefined
  } catch {
    return undefined
  }
}

export function resolvedModelInput(
  provider: Pick<Provider, 'models'>,
  target: { route: string; model: string },
): ModelInput {
  return Object.freeze(resolvedModelRecord(provider, target)?.input ?? ['text'])
}

export function supportsComputerUse(input: ModelInput): boolean {
  return input.includes('text') && input.includes('image')
}

export function modelAllowsTool(name: string, computerUseAllowed: boolean): boolean {
  return name !== 'computer_use' || computerUseAllowed
}

/** Hide Computer Use from operation-owned tool renderers such as the code-mode SDK. */
export function toolsForModel(snapshot: RegistrySnapshot, computerUseAllowed: boolean): RegistrySnapshot {
  if (computerUseAllowed || !snapshot.byName.has('computer_use')) return snapshot
  const defs = Object.freeze(
    snapshot.defs.filter((definition) => modelAllowsTool(definition.name, computerUseAllowed)),
  )
  const byName = new Map<string, RegisteredTool>()
  for (const definition of defs) {
    const registered = snapshot.byName.get(definition.name)
    if (registered) byName.set(definition.name, registered)
  }
  const hash = sha256Hex(
    canonicalJson(defs.map((definition) => ({ name: definition.name, parameters: definition.parameters }))),
  )
  return Object.freeze({ defs, byName, hash, takenAtSeq: snapshot.takenAtSeq })
}

export function toolNamesForModel(names: readonly string[], computerUseAllowed: boolean): string[] {
  return computerUseAllowed ? [...names] : names.filter((name) => modelAllowsTool(name, computerUseAllowed))
}
