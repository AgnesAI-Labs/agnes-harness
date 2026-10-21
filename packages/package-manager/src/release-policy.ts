import { readFileSync } from 'node:fs'
import {
  DEFAULT_LOOP,
  DEFAULT_PERSISTENCE_PROVIDER_ID,
  LOCAL_SANDBOX_PROVIDER_ID,
} from '@agnes/extension-api'
import { CHILD_ENGINE_ROW_IDS } from '@agnes/protocol'
import { freezeData } from './integrity.js'

/** Release policy lives beside the bundled payload catalogue, never in kernel dispatch. */
export const RELEASE_PACKAGES = [
  '@agnes/base',
  '@agnes/code',
  '@agnes/enterprise',
  '@agnes/connector-db',
  '@agnes/connector-kb',
  '@agnes/ai',
] as const
export const RELEASE_PROFILE_NAMES = ['local-dev', 'enterprise'] as const
export const RELEASE_EXTENSION_IDS: ReadonlySet<string> = new Set([
  'agnes/tools-core',
  'agnes/tools-search',
  'agnes/tools-web',
  'agnes/interaction',
  'agnes/intelligent-ui',
  'agnes/goal',
  'agnes/deliverables',
  'agnes/jobs',
  'agnes/jobs-web',
  'agnes/compaction',
  'agnes/refine',
  'agnes/subagent',
  'agnes/computer-use',
  'agnes/code-mode',
  'agnes/hooks-runner',
  'agnes/privacy',
  'agnes/plugin-creator',
  'agnes/mcp-search',
  'agnes/skills',
  'agnes/plan-mode',
  'agnes/mcp-resources',
  'agnes/workflow',
  'agnes/session-query',
  'agnes/context-rules',
  'agnes/time-context',
  'agnes/follow-up-hint',
  'agnes/schedule',
])
export const RELEASE_HOOK_RANKS: ReadonlyMap<string, number> = new Map(
  [...new Set(['agnes/skills', ...RELEASE_EXTENSION_IDS])].map((id, index) => [`ext:${id}`, index]),
)
export const RELEASE_DEFAULTS = freezeData({
  extensionOwner: '@agnes/base',
  skillExtension: 'agnes/skills',
  computerUseExtension: 'agnes/computer-use',
  modelAdapterPackage: '@agnes/ai',
  modelAdapterCompanion: '@agnes/model-adapters',
  childProvider: 'in-process',
  loop: DEFAULT_LOOP,
  persistenceProvider: DEFAULT_PERSISTENCE_PROVIDER_ID,
  sandboxProvider: LOCAL_SANDBOX_PROVIDER_ID,
  systemPrompt: { provider: 'agnes.system-prompt', version: '1.0.0' },
  demo: { route: 'demo', api: 'scripted' },
})
export const RELEASE_CHILD_ENGINES = freezeData({
  packageId: '@agnes/base',
  rows: [
    { id: CHILD_ENGINE_ROW_IDS.codex, exportName: 'codexChildAgentsPlugin', setting: 'codex' as const },
    {
      id: CHILD_ENGINE_ROW_IDS.claudeCode,
      exportName: 'claudeCodeChildAgentsPlugin',
      setting: 'claudeCode' as const,
    },
    { id: CHILD_ENGINE_ROW_IDS.sdk, exportName: 'sdkChildAgentsPlugin', setting: 'sdk' as const },
  ],
})

export const RELEASE_CLIENT_QUERIES = freezeData([
  {
    rowId: 'web:builtin:agnes/reply-suggestions',
    service: 'replies.read',
    packageId: '@agnes/base',
    extension: 'agnes/follow-up-hint',
  },
])
export function isReleasePackage(pkg: {
  enabled: boolean
  trust: string
  source: string
  version: string
  integrity: string
}): boolean {
  return (
    pkg.enabled &&
    pkg.trust === 'builtin' &&
    pkg.source === 'builtin' &&
    pkg.integrity === `builtin:${pkg.version}`
  )
}
export function releaseChildEngineOwner<
  T extends {
    id: string
    enabled: boolean
    trust: string
    source: string
    version: string
    integrity: string
  },
>(packages: readonly T[]): T | undefined {
  return packages.find((pkg) => pkg.id === RELEASE_CHILD_ENGINES.packageId && isReleasePackage(pkg))
}
/** Replaced with reviewed assets by both CLI bundlers. */
declare const AGNES_PROFILE_TEMPLATE_TEXTS: Readonly<Record<string, string>> | undefined
export function readReleaseProfileTemplate(name: string): string | undefined {
  if (!(RELEASE_PROFILE_NAMES as readonly string[]).includes(name)) return undefined
  return typeof AGNES_PROFILE_TEMPLATE_TEXTS === 'undefined'
    ? readFileSync(new URL(`../templates/${name}.yaml`, import.meta.url), 'utf8')
    : AGNES_PROFILE_TEMPLATE_TEXTS[name]
}
