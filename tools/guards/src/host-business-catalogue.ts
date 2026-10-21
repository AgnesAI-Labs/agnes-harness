/** Read identities from shipped manifests, never execute a plugin to discover its exports. */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listPackages } from './repo.js'

export const HOST_PACKAGES = [
  'host',
  'host-common',
  'host-artifacts',
  'host-computer-use',
  'host-extensions',
  'host-infrastructure',
  'host-providers',
] as const
/** A newly introduced Host package must enter the reviewed scan roots before it can ship. */
export function assertHostPackageCoverage(root: string): void {
  const unexpected = listPackages(root)
    .filter((pkg) => pkg.name === '@agnes/host' || pkg.name.startsWith('@agnes/host-'))
    .filter((pkg) => !HOST_PACKAGES.some((name) => pkg.name === `@agnes/${name}`))
  if (unexpected.length)
    throw new Error(`Unclassified Host package: ${unexpected.map((pkg) => pkg.name).join(', ')}`)
}
// Explicit substrate/contracts and release assembly. Plugin implementations (including observability) are absent.
export const CONTRACT_PACKAGES = new Set([
  '@agnes/cordis',
  '@agnes/core',
  '@agnes/core-common',
  '@agnes/core-effects',
  '@agnes/core-child-control',
  '@agnes/core-ledger',
  '@agnes/extension-api',
  '@agnes/git-worktree-contract',
  '@agnes/intelligent-ui-contract',
  '@agnes/package-manager',
  '@agnes/distribution',
  '@agnes/plugin-runtime',
  '@agnes/plugin-streams',
  '@agnes/protocol',
  '@agnes/protocol-validation',
  '@agnes/resource-control-contracts',
  '@agnes/resource-control-runtime',
  '@agnes/system-node',
  '@agnes/error-sanitization',
  '@agnes/profile',
  ...HOST_PACKAGES.map((name) => `@agnes/${name}`),
])
export const CONTRACT_LEAVES = new Set(['@agnes/observability/contract'])
export const DEFAULT_SYMBOLS = new Set([
  'DEFAULT_LOOP',
  'IN_PROCESS_CHILD_PROVIDER_ID',
  'DEFAULT_PERSISTENCE_PROVIDER_ID',
  'LOCAL_SANDBOX_PROVIDER_ID',
  'CHILD_ENGINE_ROW_IDS',
])
export type BusinessCatalogue = { tokens: Set<string>; exports: Set<string>; manifests: number }

export function businessCatalogue(root: string): BusinessCatalogue {
  // Compatibility rows/defaults are not all declared in manifests yet. Keep this explicit until A1.
  const tokens = new Set<string>([
    'child-agent:in-process',
    'compaction-engine:default',
    'scripted',
    'demo-model',
    'openai-completions',
    'openai-responses',
    'openai-codex',
    'github-copilot',
    'kimi-coding',
    'anthropic',
    'xai',
  ])
  const exports = new Set<string>()
  const visited = new Set<string>()
  const readManifest = (file: string) => {
    if (visited.has(file)) return
    visited.add(file)
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as {
      name: string
      agnes?: { plugins?: { id: string; export: string }[]; extensions?: string[] }
    }
    tokens.add(manifest.name)
    for (const plugin of manifest.agnes?.plugins ?? []) {
      tokens.add(plugin.id)
      if (plugin.id.startsWith('ext:')) tokens.add(plugin.id.slice(4))
      if (!['default', 'main'].includes(plugin.export)) exports.add(plugin.export)
    }
    for (const dir of manifest.agnes?.extensions ?? []) readManifest(join(file, '..', dir, 'package.json'))
  }
  for (const pkg of listPackages(root)) {
    if (pkg.json.agnes) readManifest(join(pkg.dir, 'package.json'))
  }
  // These manifests are the release-owned distribution payload catalogue, including optional ones.
  const bundled = join(root, 'packages/package-manager/bundled-plugins')
  for (const name of readdirSync(bundled)) {
    const file = join(bundled, name, 'package.json')
    if (existsSync(file)) readManifest(file)
  }
  if (visited.size < 30 || !tokens.has('agnes/computer-use') || !exports.has('codexChildAgentsPlugin'))
    throw new Error('Incomplete official manifest catalogue')
  return { tokens, exports, manifests: visited.size }
}

export function officialTokens(text: string, catalogue: BusinessCatalogue): string[] {
  if (CONTRACT_LEAVES.has(text)) return []
  const normalized = text
    .replaceAll('\\/', '/')
    .replace(
      /x\/agnes\/(?:interaction|intelligent-ui|subagent|deferred-invocations|privacy)\/[\w./-]*|x\/agnes\/preview-omitted/g,
      '',
    )
  const found = new Set<string>()
  for (const token of [...catalogue.tokens, ...catalogue.exports]) {
    if (CONTRACT_PACKAGES.has(token)) continue
    let offset = normalized.indexOf(token)
    while (offset >= 0) {
      const before = normalized[offset - 1] ?? ''
      const after = normalized[offset + token.length] ?? ''
      if (!/[\w@./-]/.test(before) && !/[\w.-]/.test(after)) found.add(token)
      offset = normalized.indexOf(token, offset + 1)
    }
  }
  // Reserve official identity namespaces too, including future/retired names and regex prefixes.
  for (const match of normalized.matchAll(
    /@agnes\/[\w.-]+|(?:x\/|ext:)?agnes\/[\w/-]+|agnes\.default|agnes\.system-prompt/g,
  )) {
    const value = match[0]
    if (match.index > 0 && /[\w@/]/.test(normalized[match.index - 1] ?? '')) continue
    if (!CONTRACT_PACKAGES.has(value)) found.add(value)
  }
  return [...found].sort()
}
