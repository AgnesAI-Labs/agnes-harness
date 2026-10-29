import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { ExtensionFactory } from '@agnes/extension-api/host'
import { gitWorktreeKind } from '@agnes/git-worktree-contract'
import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'
import { type BundledPlugin, extensionFactoryOf } from '@agnes/plugin-runtime/bundled'
import compactionExtension from '../extensions/compaction/src/index.js'
import { createComputerUseExtension } from '../extensions/computer-use/src/index.js'
import contextRulesExtension from '../extensions/context-rules/src/index.js'
import deliverablesExtension from '../extensions/deliverables/src/index.js'
import { createFollowUpHintExtension } from '../extensions/follow-up-hint/src/index.js'
import goalExtension from '../extensions/goal/src/index.js'
import { createHeadsUpExtension } from '../extensions/heads-up/src/index.js'
import {
  type CcHookMap,
  type HooksRunnerExtensionDeps,
  hooksRunnerExtension,
} from '../extensions/hooks-runner/src/index.js'
import intelligentUiExtension from '../extensions/intelligent-ui/src/index.js'
import interactionExtension from '../extensions/interaction/src/index.js'
import { createJobsExtension } from '../extensions/jobs/src/index.js'
import { shellJobsFor } from '../extensions/jobs/src/registry.js'
import { createJobsWebExtension } from '../extensions/jobs-web/src/index.js'
import { createLspExtension, lspFor } from '../extensions/lsp/src/index.js'
import mcpResourcesExtension from '../extensions/mcp-resources/src/index.js'
import { mcpSearchExtension } from '../extensions/mcp-search/src/index.js'
import { mcpCatalogHubFor } from '../extensions/mcp-server/src/catalog-hub.js'
import planModeExtension from '../extensions/plan-mode/src/index.js'
import pluginCreatorExtension from '../extensions/plugin-creator/src/index.js'
import { createPrivacyExtension, sessionEgressAuthority } from '../extensions/privacy/src/index.js'
import { createRefineExtension } from '../extensions/refine/src/index.js'
import { RefineQueue } from '../extensions/refine/src/queue.js'
import { createRefineHarness } from '../extensions/refine/src/seam.js'
import { createScheduleExtension } from '../extensions/schedule/src/index.js'
import { createSessionQueryExtension } from '../extensions/session-query/src/index.js'
import { skillsExtension } from '../extensions/skills/src/runtime.js'
import { createSubagentExtension, type SubagentLimits } from '../extensions/subagent/src/index.js'
import { gitWorktrees, type WorktreeEntry } from '../extensions/subagent/src/worktree.js'
import timeContextExtension from '../extensions/time-context/src/index.js'
import { createToolsCoreExtension } from '../extensions/tools-core/src/index.js'
import toolsSearchExtension from '../extensions/tools-search/src/index.js'
import { createToolsWebExtension } from '../extensions/tools-web/src/index.js'
import { createOfficialSearchProvider } from '../extensions/tools-web/src/search/index.js'
import workflowExtension from '../extensions/workflow/src/index.js'
import type { ChildWorktreePort, SeamInitContext } from './seam-init.js'

/** Replaced with the reviewed generated asset by the CLI SEA build. */
declare const AGNES_CC_HOOK_MAP_TEXT: string | undefined

const generatedHookMap = JSON.parse(
  typeof AGNES_CC_HOOK_MAP_TEXT === 'undefined'
    ? readFileSync(new URL('../extensions/hooks-runner/generated/cc-hook-map.json', import.meta.url), 'utf8')
    : AGNES_CC_HOOK_MAP_TEXT,
) as CcHookMap

export type HooksRunnerEcosystemDeps = Partial<HooksRunnerExtensionDeps>

function privacyFactory(init: SeamInitContext): BundledPlugin {
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
  hooksRunner(deps?: HooksRunnerEcosystemDeps): BundledPlugin
  refine(): BundledPlugin
  subagent(): BundledPlugin
  skills(): BundledPlugin
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
      const queue = new RefineQueue(init.adapters.storage.namespace('refine_queue'))
      const rawMax = (init.profile.preset.harness as { queue_max?: unknown } | undefined)?.queue_max ?? 20
      if (!Number.isSafeInteger(rawMax) || (rawMax as number) < 0)
        throw new Error('harness.queue_max must be a non-negative safe integer')
      return createRefineExtension(createRefineHarness(queue, rawMax as number))
    },
    subagent: () => defineSubagentExtension(init),
    skills: () => skillsExtension(init),
  }
}

/**
 * Subagent worktree binding through the Host child-control port. Nothing is loaded back: `bind`
 * follows `create` in the same tool call, and `finish` goes through the Host git registry.
 */
export function childControlWorktreePersist(port: ChildWorktreePort | undefined): {
  load(): Map<string, WorktreeEntry>
  save(entries: Map<string, WorktreeEntry>): void
  bind(childKey: string, entry: WorktreeEntry): Promise<void>
} {
  return {
    load: () => new Map(),
    save: () => undefined,
    async bind(childKey, entry) {
      if (!port) throw new Error('worktree isolation requires the Host child-control port')
      const task = await port.lookupByKey(childKey)
      if (!task?.workspaceId) throw new Error('worktree binding requires a child workspace')
      await port.updateWorkspace(task.workspaceId, {
        phase: 'attached',
        path: entry.path,
        root: entry.root,
        branch: entry.branch,
      })
    },
  }
}

function officialSearchProvider(init: SeamInitContext) {
  return createOfficialSearchProvider({
    dataDir: init.profile.dataDir,
    resolveSecret(ref) {
      try {
        const value = init.secrets(ref)
        return value.length > 0 ? value : undefined
      } catch {
        return undefined
      }
    },
  })
}

function defineSubagentExtension(init: SeamInitContext): BundledPlugin {
  const limits = readSubagentLimits(init.profile.preset)
  return defineAgnesPlugin({
    inject: ['tools', 'eventLog', 'providers'],
    apply(ctx: Context) {
      return createSubagentExtension({
        limits,
        worktrees: gitWorktrees({
          events: ctx.eventLog,
          persist: childControlWorktreePersist(init.childControl),
          open: () => ctx.providers.bindOwn(gitWorktreeKind),
        }),
      }).apply(ctx)
    },
  })
}

/** Bundled extensions as plugins; `ecosystem` mounts each one over the backend API. */

const bundled = {
  'agnes/intelligent-ui': (): BundledPlugin => intelligentUiExtension,
  'agnes/workflow': (): BundledPlugin => workflowExtension,
  'agnes/context-rules': (): BundledPlugin => contextRulesExtension,
  'agnes/follow-up-hint': (init: SeamInitContext): BundledPlugin =>
    createFollowUpHintExtension(init.sessionTasks),
  'agnes/heads-up': (init: SeamInitContext): BundledPlugin => createHeadsUpExtension(init.sessionTasks),
  'agnes/time-context': (): BundledPlugin => timeContextExtension,

  'agnes/goal': (): BundledPlugin => goalExtension,
  'agnes/interaction': (): BundledPlugin => interactionExtension,
  'agnes/deliverables': (): BundledPlugin => deliverablesExtension,
  'agnes/plugin-creator': (): BundledPlugin => pluginCreatorExtension,
  'agnes/tools-core': (init: SeamInitContext): BundledPlugin =>
    createToolsCoreExtension(shellJobsFor(init.signal), lspFor(init.signal)),
  // Shares one registry with tools-core (as jobs does): applying this extension is what turns the
  // language servers on for the write/edit results too.
  'agnes/lsp': (init: SeamInitContext): BundledPlugin => createLspExtension(lspFor(init.signal)),
  'agnes/jobs-web': (init: SeamInitContext): BundledPlugin =>
    createJobsWebExtension(shellJobsFor(init.signal)),
  'agnes/jobs': (init: SeamInitContext): BundledPlugin => createJobsExtension(shellJobsFor(init.signal)),
  'agnes/tools-search': (): BundledPlugin => toolsSearchExtension,
  'agnes/tools-web': (init: SeamInitContext): BundledPlugin =>
    createToolsWebExtension(init.searchProvider ?? officialSearchProvider(init)),
  'agnes/compaction': (): BundledPlugin => compactionExtension,
  'agnes/privacy': (init: SeamInitContext): BundledPlugin => privacyFactory(init),
  // Cross-server deferred-tool search plus the ready-Skill listing. Host hands it
  // a live Skill view; MCP servers themselves are per-server rows, never an ecosystem extension.
  'agnes/mcp-search': (init: SeamInitContext): BundledPlugin =>
    mcpSearchExtension({
      catalogHub: mcpCatalogHubFor(init),
      ...(init.skillDiscovery ? { skillDiscovery: init.skillDiscovery } : {}),
    }),
  'agnes/hooks-runner': (init: SeamInitContext): BundledPlugin =>
    createEcosystemExtensions(init).hooksRunner(),
  'agnes/refine': (init: SeamInitContext): BundledPlugin => createEcosystemExtensions(init).refine(),
  'agnes/subagent': (init: SeamInitContext): BundledPlugin => createEcosystemExtensions(init).subagent(),
  'agnes/skills': (init: SeamInitContext): BundledPlugin => createEcosystemExtensions(init).skills(),
  'agnes/plan-mode': (): BundledPlugin => planModeExtension,
  'agnes/mcp-resources': (): BundledPlugin => mcpResourcesExtension,
  'agnes/schedule': (): BundledPlugin => createScheduleExtension(),
  'agnes/computer-use': (init: SeamInitContext): BundledPlugin => {
    if (!init.computerUseBackendProvider)
      throw new Error('computer-use extension requires the Host-owned backend provider')
    return createComputerUseExtension(init.computerUseBackendProvider, init.computerUseOptions)
  },
  'agnes/session-query': (init: SeamInitContext): BundledPlugin =>
    createSessionQueryExtension({ dataDir: init.profile.dataDir }),
} as const

/**
 * Host grants the child-control port to every `@agnes/base`-owned context. For factories mounted
 * through `mountEcosystem` (the `ecosystem` map), only agnes/subagent (worktree binding) keeps it;
 * every other factory gets the context without it.
 */
export function ecosystemInitFor(id: string, init: SeamInitContext): SeamInitContext {
  if (id === 'agnes/subagent' || !('childControl' in init)) return init
  const { childControl: _port, ...rest } = init
  return rest
}

/** Mounts each bundled factory as an extension factory, narrowing its context by id first. */
export function mountEcosystem<T extends Record<string, (init: SeamInitContext) => BundledPlugin>>(
  table: T,
): { [K in keyof T]: (init: SeamInitContext) => ExtensionFactory } {
  return Object.fromEntries(
    Object.entries(table).map(([id, make]) => [
      id,
      (init: SeamInitContext) => extensionFactoryOf(make(ecosystemInitFor(id, init))),
    ]),
  ) as never
}

/** Trusted factories keyed by the manifest id the host is about to admit. */
export const ecosystem: { [K in keyof typeof bundled]: (init: SeamInitContext) => ExtensionFactory } =
  mountEcosystem(bundled)
