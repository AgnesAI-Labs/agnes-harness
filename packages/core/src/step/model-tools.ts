import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import type { ToolDef } from '@agnes/extension-api'
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

export function modelAllowsTool(
  tool: { meta: Pick<ToolDef['meta'], 'requiresImageInput'> },
  computerUseAllowed: boolean,
): boolean {
  return tool.meta.requiresImageInput !== true || computerUseAllowed
}

/** Platform action targets stay executable internally but never enter model discovery or schemas. */
export function modelVisibleTool(tool: Pick<ToolDef, 'meta'>, computerUseAllowed: boolean): boolean {
  return tool.meta.modelVisible !== false && modelAllowsTool(tool, computerUseAllowed)
}

/** Filter model discovery and operation-owned renderers such as the code-mode SDK. */
export function toolsForModel(snapshot: RegistrySnapshot, computerUseAllowed: boolean): RegistrySnapshot {
  return narrowSnapshot(snapshot, (definition) => modelVisibleTool(definition, computerUseAllowed))
}

/**
 * The turn catalog for a turn nobody attends: tools that need a person present are left out
 * entirely, so the model is neither offered them nor able to call them, and discovery cannot find
 * them. An attended turn keeps the snapshot as it is.
 */
export function toolsForAttendance(snapshot: RegistrySnapshot, unattended: boolean): RegistrySnapshot {
  return unattended
    ? narrowSnapshot(snapshot, (definition) => definition.meta.requiresUser !== true)
    : snapshot
}

function narrowSnapshot(
  snapshot: RegistrySnapshot,
  keep: (definition: ToolDef) => boolean,
): RegistrySnapshot {
  const defs = Object.freeze(snapshot.defs.filter(keep))
  if (defs.length === snapshot.defs.length) return snapshot
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

export function toolNamesForModel(
  names: readonly string[],
  snapshot: RegistrySnapshot,
  computerUseAllowed: boolean,
): string[] {
  return names.filter((name) => {
    const tool = snapshot.byName.get(name)
    return !tool || modelVisibleTool(tool, computerUseAllowed)
  })
}
