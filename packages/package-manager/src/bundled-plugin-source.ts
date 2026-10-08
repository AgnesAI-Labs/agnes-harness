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
  {
    name: 'document-reader',
    id: '@agnes/document-reader',
    version: '0.1.2',
    license: 'Apache-2.0',
    ref: 'file:./bundled-plugins/document-reader',
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

/** Reserved references name shipped examples, never an identically named workspace folder. */
export const BUNDLED_EXAMPLES = Object.freeze(
  [
    ...['dag-loop', 'react-loop'].map((name) => ({ family: 'loops', name })),
    ...[
      'code-review',
      'compliance-audit',
      'contract-review',
      'crm-assistant',
      'data-report',
      'device-inspection',
      'finance-reconcile',
      'knowledge-qa',
      'meeting-actions',
      'ops-runbook',
      'recruiting-screen',
      'support-triage',
    ].map((name) => ({ family: 'fde', name })),
    ...['tool-panel', 'mcp-skills', 'dag-loop-adapter'].map((name) => ({ family: 'community', name })),
  ].map((example) => ({ ...example, ref: `file:./bundled-examples/${example.family}/${example.name}` })),
)

export function bundledExampleSource(ref: string): { root: string; path: string } | undefined {
  const example = BUNDLED_EXAMPLES.find((item) => item.ref === ref)
  if (!example) return undefined
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const sea = process.getBuiltinModule('node:sea').isSea()
  const packaged = sea || (typeof AGNES_PACKAGED_BUILTINS !== 'undefined' && AGNES_PACKAGED_BUILTINS)
  return {
    root: sea ? dirname(process.execPath) : packaged ? moduleDir : dirname(dirname(dirname(moduleDir))),
    path: `${packaged ? 'bundled-examples' : 'examples'}/${example.family}/${example.name}`,
  }
}
