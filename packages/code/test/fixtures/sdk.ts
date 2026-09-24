import { type RegistrySnapshot, ToolRegistry } from '@agnes/core'
import type { ToolDef } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'

const schema = (value: unknown) => value as ToolDef['parameters']
export function tool(name: string, parameters: unknown = Type.Object({}), deferred = false): ToolDef {
  return {
    name,
    description: name,
    parameters: schema(parameters),
    meta: {
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'safe',
      costHint: undefined,
      deferLoading: deferred,
      requiresApproval: 'never',
    },
    async execute() {
      return { content: [] }
    },
  }
}
export function snapshot(tools: ToolDef[]): RegistrySnapshot {
  const registry = new ToolRegistry()
  for (const def of tools) registry.add(def, { source: 'fixture/sdk', trust: 'trusted' })
  return registry.snapshot(0)
}
