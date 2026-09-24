import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

declare const AGNES_PACKAGED_BUILTINS: boolean | undefined
export const BUNDLED_SKILL_HELPER_REF = 'file:./bundled-plugins/skill-helper'

export const BUNDLED_HELPERS = Object.freeze([
  {
    name: 'skill-helper',
    id: '@agnes/skill-helper',
    version: '0.1.1',
    license: 'MIT',
    ref: BUNDLED_SKILL_HELPER_REF,
  },
  {
    name: 'mcp-helper',
    id: '@agnes/mcp-helper',
    version: '0.1.0',
    license: 'Apache-2.0',
    ref: 'file:./bundled-plugins/mcp-helper',
  },
  {
    name: 'plugin-helper',
    id: '@agnes/plugin-helper',
    version: '0.1.1',
    license: 'Apache-2.0',
    ref: 'file:./bundled-plugins/plugin-helper',
  },
])

/** Only this reserved identity is runtime-owned; ordinary file sources keep workspace semantics. */
export function bundledPluginSourceRoot(ref: string): string | undefined {
  if (!BUNDLED_HELPERS.some((helper) => helper.ref === ref)) return undefined
  if (process.getBuiltinModule('node:sea').isSea()) return dirname(process.execPath)
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  return typeof AGNES_PACKAGED_BUILTINS !== 'undefined' && AGNES_PACKAGED_BUILTINS
    ? moduleDir
    : dirname(moduleDir)
}
