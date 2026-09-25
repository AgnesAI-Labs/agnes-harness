import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ExtensionFactory } from '@agnes/extension-api'
import compactionExtension from '../extensions/compaction/src/index.js'
import { createComputerUseExtension } from '../extensions/computer-use/src/index.js'
import {
  type CcHookMap,
  type HooksRunnerExtensionDeps,
  hooksRunnerExtension,
} from '../extensions/hooks-runner/src/index.js'
import { mcpSearchExtension } from '../extensions/mcp-search/src/index.js'
import { mcpCatalogHubFor } from '../extensions/mcp-server/src/catalog-hub.js'
import { createPrivacyExtension, sessionEgressAuthority } from '../extensions/privacy/src/index.js'
import { createRefineExtension } from '../extensions/refine/src/index.js'
import { RefineQueue } from '../extensions/refine/src/queue.js'
import { createRefineHarness } from '../extensions/refine/src/seam.js'
import { skillsExtension } from '../extensions/skills/src/runtime.js'
import { createSubagentExtension, type SubagentLimits } from '../extensions/subagent/src/index.js'
import { gitWorktrees, type WorktreeEntry } from '../extensions/subagent/src/worktree.js'
import toolsCoreExtension from '../extensions/tools-core/src/index.js'
import toolsSearchExtension from '../extensions/tools-search/src/index.js'
import toolsWebExtension from '../extensions/tools-web/src/index.js'
import type { SeamInitContext } from './seam-init.js'

/** Replaced with the reviewed generated asset by the CLI SEA build. */
declare const AGNES_CC_HOOK_MAP_TEXT: string | undefined

const generatedHookMap = JSON.parse(
  typeof AGNES_CC_HOOK_MAP_TEXT === 'undefined'
    ? readFileSync(new URL('../extensions/hooks-runner/generated/cc-hook-map.json', import.meta.url), 'utf8')
    : AGNES_CC_HOOK_MAP_TEXT,
) as CcHookMap

export type HooksRunnerEcosystemDeps = Partial<HooksRunnerExtensionDeps>

function privacyFactory(init: SeamInitContext): ExtensionFactory {
  const trajectory = init.privacyTrajectory
  return createPrivacyExtension({
    rules: {
      paths: {
        home: init.profile.homeDir,
        workspaceRoot: init.profile.workspaceRoot,
        username: basename(init.profile.homeDir),
      },
    },
    ...(trajectory
      ? {
          trajectory: {
            previous: trajectory.previous,
            upload: (session, gate, signal) =>
              trajectory.upload(session, gate, sessionEgressAuthority, signal),
          },
        }
      : {}),
  })
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Read the policy values from the resolved preset instead of inventing process-global limits. */
export function readSubagentLimits(preset: Record<string, unknown>): SubagentLimits {
  const section = preset.subagent
  if (!isRecord(section)) throw new Error('resolved preset is missing subagent policy')
  const maxDepth = section.max_depth
  const maxFanOut = section.max_fan_out
  const isolation = section.isolation
  if (!Number.isSafeInteger(maxDepth) || (maxDepth as number) < 0)
    throw new Error('subagent.max_depth must be a non-negative safe integer')
  if (!Number.isSafeInteger(maxFanOut) || (maxFanOut as number) < 0)
    throw new Error('subagent.max_fan_out must be a non-negative safe integer')
  if (isolation !== 'worktree' && isolation !== 'shared')
    throw new Error('subagent.isolation must be worktree or shared')
  return { maxDepth: maxDepth as number, maxFanOut: maxFanOut as number, isolation }
}

/** Factories that need the trusted assembly context, kept separate from the static extension host. */
export function createEcosystemExtensions(init: SeamInitContext): {
  hooksRunner(deps?: HooksRunnerEcosystemDeps): ExtensionFactory
  refine(): ExtensionFactory
  subagent(): ExtensionFactory
  skills(): ExtensionFactory
} {
  return {
    hooksRunner: (deps = {}) =>
      hooksRunnerExtension(init, {
        map: deps.map ?? generatedHookMap,
        workspaceSnapshots: true,
        ...(deps.sandbox === undefined ? {} : { sandbox: deps.sandbox }),
        ...(deps.http === undefined ? {} : { http: deps.http }),
      }),
    refine: () => {
      const queue = new RefineQueue(init.adapters.storage.table('refine_queue'))
      const rawMax = (init.profile.preset.harness as { queue_max?: unknown } | undefined)?.queue_max ?? 20
      if (!Number.isSafeInteger(rawMax) || (rawMax as number) < 0)
        throw new Error('harness.queue_max must be a non-negative safe integer')
      return createRefineExtension(createRefineHarness(queue, rawMax as number))
    },
    subagent: () => defineSubagentExtension(init),
    skills: () => skillsExtension(init),
  }
}

const darwin = process.platform === 'darwin' // guards-allow-platform: F_FULLFSYNC is darwin-only.

function sqliteWorktreePersist(dataDir: string): {
  load(): Map<string, WorktreeEntry>
  save(entries: Map<string, WorktreeEntry>): void
  bind(childKey: string, entry: WorktreeEntry): void
} {
  const dbPath = join(dataDir, 'sessions.db')
  const open = (): DatabaseSync | null => {
    if (!existsSync(dbPath)) return null
    const db = new DatabaseSync(dbPath)
    // A write here can checkpoint the WAL ledger; on darwin only F_FULLFSYNC makes that durable.
    if (darwin) db.exec('PRAGMA checkpoint_fullfsync = ON')
    return db
  }
  return {
    load() {
      const db = open()
      const out = new Map<string, WorktreeEntry>()
      if (!db) return out
      try {
        const rows = db
          .prepare(
            `SELECT path, root, branch, phase FROM child_workspaces WHERE isolation = 'worktree' AND path IS NOT NULL`,
          )
          .all() as Array<{ path: string; root: string | null; branch: string | null; phase: string }>
        for (const row of rows) {
          if (!row.root || !row.branch) continue
          out.set(row.path, {
            root: row.root,
            path: row.path,
            branch: row.branch,
            stage: row.phase === 'worktree_removed' ? 'worktree-removed' : 'attached',
          })
        }
      } finally {
        db.close()
      }
      return out
    },
    save() {
      // bind() is the durable write; save keeps the in-memory map consistent for finish.
    },
    bind(childKey, entry) {
      const db = open()
      if (!db) return
      try {
        db.prepare(
          `UPDATE child_workspaces SET path = ?, phase = 'attached', root = ?, branch = ? WHERE child_key = ?`,
        ).run(entry.path, entry.root, entry.branch, childKey)
        db.prepare(`UPDATE child_tasks SET cwd = ? WHERE child_key = ?`).run(entry.path, childKey)
      } finally {
        db.close()
      }
    },
  }
}

function defineSubagentExtension(init: SeamInitContext): ExtensionFactory {
  const limits = readSubagentLimits(init.profile.preset)
  return (agnes) =>
    createSubagentExtension({
      limits,
      worktrees: gitWorktrees({ events: agnes.events, persist: sqliteWorktreePersist(init.profile.dataDir) }),
    })(agnes)
}

/** Trusted factories keyed by the manifest id the host is about to admit. */
export const ecosystem = {
  'agnes/tools-core': (): ExtensionFactory => toolsCoreExtension,
  'agnes/tools-search': (): ExtensionFactory => toolsSearchExtension,
  'agnes/tools-web': (): ExtensionFactory => toolsWebExtension,
  'agnes/compaction': (): ExtensionFactory => compactionExtension,
  'agnes/privacy': (init: SeamInitContext): ExtensionFactory => privacyFactory(init),
  // Cross-server deferred-tool search plus the ready-Skill listing (design §3.9, D123). Host hands it
  // a live Skill view; MCP servers themselves are per-server rows, never an ecosystem extension.
  'agnes/mcp-search': (init: SeamInitContext): ExtensionFactory =>
    mcpSearchExtension({
      catalogHub: mcpCatalogHubFor(init),
      ...(init.skillDiscovery ? { skillDiscovery: init.skillDiscovery } : {}),
    }),
  'agnes/hooks-runner': (init: SeamInitContext): ExtensionFactory =>
    createEcosystemExtensions(init).hooksRunner(),
  'agnes/refine': (init: SeamInitContext): ExtensionFactory => createEcosystemExtensions(init).refine(),
  'agnes/subagent': (init: SeamInitContext): ExtensionFactory => createEcosystemExtensions(init).subagent(),
  'agnes/skills': (init: SeamInitContext): ExtensionFactory => createEcosystemExtensions(init).skills(),
  'agnes/computer-use': (init: SeamInitContext): ExtensionFactory => {
    if (!init.computerUseBackendProvider)
      throw new Error('computer-use extension requires the Host-owned backend provider')
    return createComputerUseExtension(init.computerUseBackendProvider, init.computerUseOptions)
  },
} as const
