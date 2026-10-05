import { dirname, join } from 'node:path'
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
  {
    name: 'jev-web',
    id: '@agnes/jev-web',
    version: '0.1.0',
    license: 'Apache-2.0',
    ref: 'file:./jev-web',
  },
])

/** Only this reserved identity is runtime-owned; ordinary file sources keep workspace semantics. */
export function bundledPluginSourceRoot(ref: string): string | undefined {
  if (!BUNDLED_HELPERS.some((helper) => helper.ref === ref)) return undefined
  const clientPackage = ref === 'file:./jev-web'
  if (process.getBuiltinModule('node:sea').isSea())
    return clientPackage ? join(dirname(process.execPath), 'bundled-plugins') : dirname(process.execPath)
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const packaged = typeof AGNES_PACKAGED_BUILTINS !== 'undefined' && AGNES_PACKAGED_BUILTINS
  return clientPackage
    ? packaged
      ? join(moduleDir, 'bundled-plugins')
      : dirname(dirname(moduleDir))
    : packaged
      ? moduleDir
      : dirname(moduleDir)
}
