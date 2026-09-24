import type { RegistrySnapshot } from '@agnes/core'
import { PY_RESERVED, pythonBinding } from './bindings.js'
import { pyString, SchemaRenderer } from './schema.js'

export { PY_RESERVED, pythonBinding } from './bindings.js'
export { annotate } from './schema.js'
export type SkipReason = 'reserved-word' | 'name-collision' | 'unrenderable-name' | 'deferred' | 'self'
export function renderPython(
  snapshot: RegistrySnapshot,
  opts: { onSkip?(name: string, reason: SkipReason): void } = {},
): string {
  const schema = new SchemaRenderer(),
    methods: string[] = [],
    taken = new Set<string>()
  for (const tool of [...snapshot.defs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const binding = pythonBinding(tool.name)
    const reason: SkipReason | undefined =
      tool.name === 'run_code'
        ? 'self'
        : tool.meta.deferLoading
          ? 'deferred'
          : !binding
            ? 'unrenderable-name'
            : PY_RESERVED.has(binding.binding)
              ? 'reserved-word'
              : taken.has(binding.binding)
                ? 'name-collision'
                : undefined
    if (reason) {
      opts.onSkip?.(tool.name, reason)
      continue
    }
    if (!binding) continue
    taken.add(binding.binding)
    const properties = tool.parameters.properties as Record<string, unknown> | undefined
    const entries = Object.entries(properties ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const required = new Set(tool.parameters.required as string[] | undefined)
    const unsafeKeys = entries.some(([key]) => pythonBinding(key)?.binding !== key || PY_RESERVED.has(key))
    let args: string
    if (unsafeKeys) args = `**kwargs: Unpack[${schema.annotation(tool.parameters)}]`
    else {
      const named = entries.map(
        ([key, value]) => `${key}: ${schema.annotation(value)}${required.has(key) ? '' : ' = ...'}`,
      )
      args = named.length ? `*, ${named.join(', ')}` : ''
    }
    if (binding.renamed) methods.push(`    # tool name: ${pyString(tool.name)}`)
    methods.push(`    async def ${binding.binding}(${args}) -> Any: ...`)
  }
  return [
    '# Generated SDK - every call goes back through the harness (approval, sandbox and accounting apply).',
    'from __future__ import annotations',
    'from typing import Any, Literal, TypedDict, Required, NotRequired, Unpack',
    ...schema.declarations,
    '',
    'class tools:',
    ...(methods.length ? methods : ['    pass']),
    '',
    '# Use await tools.<name>(...) with keyword arguments only; schema validation stays in the harness.',
  ].join('\n')
}
