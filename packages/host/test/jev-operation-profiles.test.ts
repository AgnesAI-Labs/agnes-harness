import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  createEcosystemExtensions,
  TOOLS_CORE,
  TOOLS_WEB,
  toolDescribeTool,
  toolSearchTool,
} from '@agnes/base'
import { type RegisteredTool, type SessionImpl, ToolRegistry } from '@agnes/core'
import type { ExtensionAPI, ToolDef } from '@agnes/extension-api'
import type {
  CandidateContext,
  FrozenIntent,
  JsonValue,
  RuntimeLedger,
  ToolDescriptor,
} from '@agnes/jev-runtime'
import { validateAgainst } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { verifiedOperationProfile } from '../src/runtime/jev-operation-profiles.js'
import { createJevToolSemantics } from '../src/runtime/jev-tool-semantics.js'

// Load filesystem package fixtures through their declared entry, just as the package host does.
async function definitions(): Promise<RegisteredTool[]> {
  const registry = new ToolRegistry()
  const add = (definition: ToolDef, source: string) => registry.add(definition, { source, trust: 'builtin' })
  for (const tool of TOOLS_CORE.filter((t) => ['shell', 'todo'].includes(t.name)))
    add(tool, 'agnes/tools-core')
  for (const tool of TOOLS_WEB) add(tool, 'agnes/tools-web')
  const hub = {} as Parameters<typeof toolSearchTool>[0]
  add(toolSearchTool(hub), 'agnes/mcp-search')
  add(toolDescribeTool(hub), 'agnes/mcp-search')
  const init = {
    skillResources: {},
    adapters: { storage: { table: () => ({ exec: () => {} }) } },
    profile: {
      dataDir: '/unused',
      preset: { subagent: { max_depth: 2, max_fan_out: 2, isolation: 'shared' } },
    },
  } as unknown as Parameters<typeof createEcosystemExtensions>[0]
  const factories = createEcosystemExtensions(init)
  for (const [id, factory] of [
    ['skills', factories.skills],
    ['refine', factories.refine],
    ['subagent', factories.subagent],
  ] as const) {
    factory()({
      registerTool: (tool: ToolDef) => add(tool, `agnes/${id}`),
      registerHook: () => () => {},
      events: {},
    } as unknown as ExtensionAPI)
  }
  for (const id of ['plugin-helper', 'skill-helper', 'mcp-helper']) {
    const root = new URL(`../../package-manager/bundled-plugins/${id}/`, import.meta.url)
    const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
    const module = await import(/* @vite-ignore */ new URL(manifest.exports, root).href)
    const row = manifest.agnes.plugins[0]
    const source = `plugin/${createHash('sha256').update(row.id).digest('hex').slice(0, 16)}`
    module[row.export].apply({
      extension: () => ({
        registerTool: (tool: ToolDef) =>
          registry.add(tool, {
            source,
            trust: 'trusted',
            packageIdentity: manifest.name,
            packageVersion: manifest.version,
          }),
      }),
    })
  }
  return [...registry.snapshot(1).byName.values()]
}
function descriptor(tool: RegisteredTool): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    parameters: JSON.parse(JSON.stringify(tool.parameters)) as JsonValue,
    output: {},
    revision: tool.definitionFingerprint,
    effectClass: 'workspace_mutation',
  }
}

describe('reviewed operation profiles', () => {
  it('pins every real definition and rejects forged ownership, contracts and revisions', async () => {
    const tools = await definitions()
    for (const tool of tools) {
      if (['subagent_send_message', 'subagent_interrupt'].includes(tool.name)) continue
      const view = descriptor(tool)
      expect(verifiedOperationProfile(tool, view), tool.name).toMatchObject({
        operation: tool.name,
        toolRevision: view.revision,
      })
      expect(verifiedOperationProfile(tool, { ...view, revision: 'changed' })).toBeUndefined()
      expect(
        verifiedOperationProfile({ ...tool, source: { ...tool.source, source: 'plugin/forged' } }, view),
      ).toBeUndefined()
      expect(
        verifiedOperationProfile(
          {
            ...tool,
            source: { ...tool.source, trust: tool.source.trust === 'builtin' ? 'trusted' : 'builtin' },
          },
          view,
        ),
      ).toBeUndefined()
      expect(
        verifiedOperationProfile({ ...tool, executionDomain: 'host-computer-use' }, view),
      ).toBeUndefined()
      if (tool.source.trust === 'trusted')
        expect(verifiedOperationProfile({ ...tool, packageIdentity: '@vendor/forged' }, view)).toBeUndefined()
      expect(
        verifiedOperationProfile({ ...tool, description: `${tool.description} changed` }, view),
      ).toBeUndefined()
      expect(
        verifiedOperationProfile(
          { ...tool, parameters: { ...tool.parameters, additionalProperties: true } },
          view,
        ),
      ).toBeUndefined()
      expect(
        verifiedOperationProfile(
          { ...tool, meta: { ...tool.meta, isReadOnly: !tool.meta.isReadOnly } },
          view,
        ),
      ).toBeUndefined()
    }
    expect(
      tools.filter((t) => !['subagent_send_message', 'subagent_interrupt'].includes(t.name)),
    ).toHaveLength(20)
  })
  it('keeps purpose, state branches and evidence limits independent of effect class', async () => {
    const tools = await definitions()
    const profile = (name: string) => {
      const tool = tools.find((t) => t.name === name)
      if (!tool) throw new Error(`Missing tool ${name}`)
      const result = verifiedOperationProfile(tool, { ...descriptor(tool), effectClass: 'external_write' })
      if (!result) throw new Error(`Missing profile ${name}`)
      return result
    }
    expect(profile('shell').phases).toEqual(['INSPECT', 'ACT', 'VERIFY'])
    expect(profile('shell').constraints.join(' ')).toContain('Prefer read/find/grep/ls/write/edit')
    expect(profile('skill_read').inputs).toContain('UTF-8 byte offset')
    expect(profile('skill_read').constraints.join(' ')).toContain('pageKey')
    expect(profile('skill_read_file').inputs).toContain('expectedRevision')
    expect(profile('subagent_fork').selection).toContain('synchronous one-shot')
    expect(profile('subagent_spawn').selection).toContain('continuable')
    expect(profile('subagent_spawn').constraints.join(' ')).toContain('fall back to shared cwd')
    expect(profile('subagent_collect').phases).toEqual(['INSPECT', 'VERIFY'])
    expect(profile('subagent_collect').constraints.join(' ')).toContain('running is not terminal completion')
    expect(profile('mcp_manage').inputs).toBe(
      'prepare: definition; commit/status/cancel: proposalId; list: no state input',
    )
    for (const name of ['skill_helper_install', 'plugin_helper_install']) {
      expect(profile(name).inputs).toContain('commit, status or cancel')
      expect(profile(name).phases).toEqual(['INSPECT', 'ACT', 'VERIFY'])
      expect(profile(name).constraints.join(' ')).toMatch(/not (readiness|success)/)
    }
    expect(profile('skill_helper_import').result).toContain('selection_required')
    expect(profile('harness_propose').constraints.join(' ')).toContain('queued does not establish')
    // A caller cannot mutate a returned profile and weaken subsequent guidance.
    Reflect.set(profile('shell').constraints, 'length', 0)
    expect(profile('shell').constraints).toHaveLength(2)
  })
  it('exposes reviewed profiles and schema-valid observed candidates through the Host companion', async () => {
    const tools = await definitions()
    const ledger: RuntimeLedger<number> = { read: async () => [], commit: async () => 1, cursorText: String }
    const makeCompanions = (definitions: RegisteredTool[]) =>
      createJevToolSemantics({
        session: {
          lastSeq: 1,
          currentTools: () => ({
            snapshot: () => ({ byName: new Map(definitions.map((tool) => [tool.name, tool])) }),
          }),
          d: { cwd: '/synthetic-workspace' },
        } as unknown as SessionImpl,
        ledger,
      })
    const companions = makeCompanions(tools)
    for (const tool of tools) {
      const view = descriptor(tool)
      expect(companions.describeTool(view), tool.name).toMatchObject({
        operation: tool.name,
        toolRevision: view.revision,
      })
      expect(companions.describeTool({ ...view, revision: 'replacement' })).toBeUndefined()
      expect(companions.effectClass(view)).toBe(
        ['subagent_send_message', 'subagent_interrupt'].includes(tool.name) ? 'external_write' : undefined,
      )
    }
    const replaced = makeCompanions(
      tools.map((tool) => ({
        ...tool,
        definitionFingerprint: 'replacement',
        description: `${tool.description} changed contract`,
      })),
    )
    for (const tool of tools) {
      expect(replaced.describeTool(descriptor(tool)), tool.name).toBeUndefined()
      expect(
        replaced.describeTool({ ...descriptor(tool), revision: 'replacement' }),
        tool.name,
      ).toBeUndefined()
    }
    const spawn = tools.find((tool) => tool.name === 'subagent_spawn')
    const skill = tools.find((tool) => tool.name === 'skill_read')
    const collect = tools.find((tool) => tool.name === 'subagent_collect')
    if (!spawn || !skill || !collect) throw new Error('Missing operation definitions')
    const epoch = 'epoch' as FrozenIntent['environmentEpoch']
    const context = {
      limit: 10,
      environmentRecord: {},
      records: [
        {
          kind: 'resource.observed',
          id: 'catalog',
          resource: { kind: 'jev.skill-catalog.v1', complete: true, entries: [{ name: 'review' }] },
        },
        {
          kind: 'action.intended',
          id: 'spawn-intended',
          intent: { id: 'spawn', tool: spawn.name, toolRevision: spawn.definitionFingerprint },
        },
        {
          kind: 'action.settled',
          id: 'spawn-settled',
          intentId: 'spawn',
          effect: 'applied',
          outcome: { kind: 'success', value: { childKey: 'child-1', isolation: 'shared' } },
        },
      ],
    } as unknown as CandidateContext
    for (const tool of [skill, collect]) {
      const view = descriptor(tool)
      const candidates = [...companions.semantics.candidates(view, [], epoch, context)]
      expect(candidates, tool.name).toHaveLength(1)
      expect(validateAgainst(tool.parameters, candidates[0]?.arguments).ok, tool.name).toBe(true)
      expect(candidates[0]?.arguments).toEqual(
        tool === skill ? { name: 'review' } : { childKey: 'child-1', wait: false },
      )
      expect([
        ...companions.semantics.candidates({ ...view, revision: 'replacement' }, [], epoch, context),
      ]).toEqual([])
    }
  })
})
