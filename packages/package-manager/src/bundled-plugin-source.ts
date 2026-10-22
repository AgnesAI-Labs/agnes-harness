import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

declare const AGNES_PACKAGED_BUILTINS: boolean | undefined
export const BUNDLED_SKILL_HELPER_REF = 'file:./bundled-plugins/skill-helper'

export const BUNDLED_HELPERS = Object.freeze([
  {
    name: 'skill-helper',
    id: '@agnes/skill-helper',
    version: '0.3.1',
    license: 'MIT',
    ref: BUNDLED_SKILL_HELPER_REF,
  },
  {
    name: 'mcp-helper',
    id: '@agnes/mcp-helper',
    version: '0.1.1',
    license: 'Apache-2.0',
    ref: 'file:./bundled-plugins/mcp-helper',
  },
  {
    name: 'plugin-helper',
    id: '@agnes/plugin-helper',
    version: '0.2.13',
    license: 'Apache-2.0',
    ref: 'file:./bundled-plugins/plugin-helper',
  },
  ...['goal-ui', 'interaction-ui', 'navigation-ui', 'conversation-ui'].map((name) => ({
    name,
    id: `@agnes/${name}`,
    version: name === 'goal-ui' || name === 'interaction-ui' ? '0.1.2' : '0.1.1',
    license: 'Apache-2.0',
    ref: `file:./bundled-plugins/${name}`,
    optionalUnderCeiling: true,
  })),
  {
    name: 'deliverables-ui',
    id: '@agnes/deliverables-ui',
    version: '0.1.3',
    license: 'Apache-2.0',
    ref: 'file:./bundled-plugins/deliverables-ui',
    optionalUnderCeiling: true,
  },
  {
    name: 'document-reader',
    id: '@agnes/document-reader',
    version: '0.1.3',
    license: 'Apache-2.0',
    ref: 'file:./bundled-plugins/document-reader',
  },
  {
    name: 'browser',
    id: '@agnes/browser',
    version: '0.1.10',
    license: 'Apache-2.0',
    ref: 'file:./bundled-plugins/browser',
    optionalUnderCeiling: true,
  },
])

/** Shipped discovery choices; never auto-installed or enabled in profiles. */
export const OPTIONAL_BUNDLED_PACKAGES: readonly {
  name: string
  id: string
  version: string
  license: string
  ref: string
  sourcePath: string
  /** Set when the entry is generated: the command that builds it in a development checkout. */
  build?: string
}[] = Object.freeze([
  {
    name: 'jev-loop',
    id: '@agnes/jev-loop',
    version: '0.1.2',
    license: 'Apache-2.0',
    ref: 'file:./bundled-plugins/jev-loop',
    // index.mjs is generated from packages/loop-jev and is not committed.
    sourcePath: 'package-manager/bundled-plugins/jev-loop',
    build: 'pnpm --filter @agnes/package-manager build:jev-payload',
  },
])

/** Release-owned defaults; freshOnly additions never backfill an existing profile. */
export const DEFAULT_ENABLED_BUNDLED_PACKAGES = Object.freeze([
  ...BUNDLED_HELPERS.map((helper) => ({
    optionalUnderCeiling: false,
    ...helper,
    sourcePath: `package-manager/bundled-plugins/${helper.name}`,
    freshOnly: false,
  })),
])

/** Resolve reserved release payloads independently of the caller's workspace. */
export function bundledPluginSource(ref: string): { root: string; path: string } | undefined {
  const pkg = [...DEFAULT_ENABLED_BUNDLED_PACKAGES, ...OPTIONAL_BUNDLED_PACKAGES].find(
    (item) => item.ref === ref,
  )
  if (!pkg) return undefined
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const sea = process.getBuiltinModule('node:sea').isSea()
  const packaged = sea || (typeof AGNES_PACKAGED_BUILTINS !== 'undefined' && AGNES_PACKAGED_BUILTINS)
  return {
    root: sea ? dirname(process.execPath) : packaged ? moduleDir : dirname(dirname(moduleDir)),
    path: packaged ? `bundled-plugins/${pkg.name}` : pkg.sourcePath,
  }
}

/** Written beside the shipped payloads at build time: `{ [source.path]: hashDirectory(payload) }`. */
export const BUNDLED_PLUGIN_DIGESTS = 'bundled-plugin-digests.json'

/** The build-time digest of a shipped payload, or undefined (missing, unreadable, partial) so the
 * caller hashes the source itself. It ships with the payload and carries the trust of that code. */
export function bundledPluginDigest(source: { root: string; path: string }): string | undefined {
  try {
    const digests: unknown = JSON.parse(readFileSync(join(source.root, BUNDLED_PLUGIN_DIGESTS), 'utf8'))
    const digest =
      digests && typeof digests === 'object'
        ? Object.entries(digests).find(([path]) => path === source.path)?.[1]
        : undefined
    return typeof digest === 'string' && /^sha256-[a-f0-9]{64}$/.test(digest) ? digest : undefined
  } catch {
    return undefined
  }
}

/** Only this reserved identity is runtime-owned; ordinary file sources keep workspace semantics. */
export function bundledPluginSourceRoot(ref: string): string | undefined {
  if (![...BUNDLED_HELPERS, ...OPTIONAL_BUNDLED_PACKAGES].some((helper) => helper.ref === ref))
    return undefined
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
    ...['data-report', 'finance-reconcile', 'knowledge-qa', 'ops-runbook', 'support-triage'].map((name) => ({
      family: 'fde',
      name,
    })),
    { family: 'showcase', name: 'pharma-gmp' },
    ...['tool-panel', 'mcp-skills', 'dag-loop-adapter'].map((name) => ({ family: 'community', name })),
    { family: 'showcase', name: 'aerospace-quality' },
    { family: 'showcase', name: 'devboard' },
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
