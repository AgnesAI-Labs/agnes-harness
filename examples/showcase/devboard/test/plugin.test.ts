import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  checkServiceDef,
  checkToolDef,
  type ServiceDef,
  type ToolDef,
} from '../../../../packages/extension-api/src/index.js'
import { parsePackageBundleContract } from '../../../../packages/package-manager/src/index.js'
import { read, seed, update } from '../domain.mjs'
import { main } from '../index.mjs'

// The plugin imports the host-provided runtime; tests resolve it from source.
vi.mock('@agnes/plugin-runtime', () => import('../../../../packages/plugin-runtime/src/author.js'))
vi.mock(
  '@sinclair/typebox',
  () => import('../../../../packages/plugin-runtime/node_modules/@sinclair/typebox/build/esm/index.mjs'),
)

// biome-ignore lint/suspicious/noExplicitAny: plugin entry and store are untyped JavaScript
type Any = any

function memoryStore(readOnly = false) {
  const rows = new Map<string, unknown>()
  const deny = () => {
    throw new Error('CAPABILITY_DENIED')
  }
  return {
    rows,
    get: (key: string) => (rows.has(key) ? structuredClone(rows.get(key)) : undefined),
    set: readOnly ? deny : (key: string, value: unknown) => void rows.set(key, structuredClone(value)),
    delete: readOnly ? deny : (key: string) => void rows.delete(key),
    transaction: <T>(work: () => T) => work(),
  }
}

const tools: ToolDef[] = []
const services: ServiceDef[] = []
const skills: { name: string }[] = []
;(main as Any).apply({
  tools: { register: (d: ToolDef) => tools.push(d) },
  services: { register: (d: ServiceDef) => services.push(d) },
  skills: { register: (d: { name: string }) => skills.push(d) },
})
const tool = (name: string) => tools.find((t) => t.name === name) as Any
const service = (name: string) => services.find((s) => s.name === name) as Any
const signal = new AbortController().signal

describe('DevBoard plugin contract', () => {
  it('registers well-formed tools, services and the playbook skill', () => {
    expect(tools).toHaveLength(15)
    expect(services.map((s) => s.name).sort()).toEqual([
      'devboard.artifact',
      'devboard.create',
      'devboard.gate',
      'devboard.reset',
      'devboard.snapshot',
      'devboard.transition',
    ])
    for (const t of tools) {
      expect(checkToolDef(t, { prefix: 'devboard_' }), t.name).toMatchObject({ ok: true })
      expect(t.meta.presentation?.title, t.name).toMatch(/[\u4e00-\u9fff]/u)
    }
    for (const s of services) expect(checkServiceDef(s), s.name).toMatchObject({ ok: true })
    expect(skills.map((s) => s.name)).toEqual(['devboard-playbook'])
  })

  it('serves a seed document from a read-only store without writing', async () => {
    const store = memoryStore(true)
    const snap = await service('devboard.snapshot').handler({}, { store })
    expect(snap.projects).toHaveLength(3)
    const body = await service('devboard.artifact').handler({ artifactId: 'DOC-042-SRS' }, { store })
    expect(body).toMatchObject({ source: 'seed', truncated: false })
    expect(body.markdown).toContain('SWR-')
    expect(await service('devboard.artifact').handler({ artifactId: 'DOC-404' }, { store })).toMatchObject({
      ok: false,
    })
    const prepared = await service('devboard.gate').prepare({}, { store })
    expect(prepared.resourceRevision).toBe('1')
  })

  it('refuses an illegal gate decision as an answer, not a failure, and writes through update only', async () => {
    const store = memoryStore()
    const gate = read(store).gates.find(
      (g: Any) => g.decision === 'PENDING' && g.findings.some((f: Any) => !f.closed),
    )
    const ctx = { store, signal }
    const refused = await service('devboard.gate').handler(
      { gateId: gate.id, decision: 'APPROVED', by: '任意审批人' },
      ctx,
    )
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('评审门不满足')
    expect(await service('devboard.reset').handler({}, ctx)).toMatchObject({ ok: true })
  })

  it('reads a live document in the tool, keeps it inside the project directory and previews it', async () => {
    const store = memoryStore()
    const created = await tool('devboard_project_create').execute({ name: '车门健康监测看板' }, {
      store,
      signal,
    } as Any)
    const project = created.structured.data
    const files = new Map([[`${project.workspaceDir}/docs/PROJECT-PLAN.md`, '# 项目计划\n\n范围与里程碑']])
    const fs = {
      read: async (path: string) => {
        const text = files.get(path)
        if (text === undefined) throw new Error('ENOENT')
        return new TextEncoder().encode(text)
      },
    }
    const ctx = { store, signal, fs } as Any
    const base = { projectId: project.id, stage: 'INITIATION', kind: 'PLAN' }
    const recorded = await tool('devboard_artifact_record').execute(
      { ...base, path: 'docs/PROJECT-PLAN.md' },
      ctx,
    )
    expect(recorded.isError).toBeFalsy()
    const preview = await service('devboard.artifact').handler(
      { artifactId: recorded.structured.data.id },
      { store },
    )
    expect(preview).toMatchObject({ source: 'workspace', markdown: '# 项目计划\n\n范围与里程碑' })
    for (const path of ['../PRJ-2025-042/x.md', '/etc/passwd', 'docs/../../x.md', 'docs/missing.md'])
      expect((await tool('devboard_artifact_record').execute({ ...base, path }, ctx)).isError, path).toBe(
        true,
      )
    expect(update(store, (s: Any) => s.artifacts.length).result).toBe(seed(Date.now()).artifacts.length + 1)
  })

  it('resolves declared roles with narrow tools and keeps approved commands in the coordinator', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const { bundles, application } = pkg.agnes
    const contracts = parsePackageBundleContract(pkg.name, bundles)
    const coordinator = bundles.coordinator
    const policy = coordinator.presets.devboard.approval.command_policy
    expect(policy.length).toBeGreaterThan(0)
    expect(policy.every((r: { tool: string }) => r.tool === 'edit|write')).toBe(true)
    expect(coordinator.presets.devboard.subagent.isolation).toBe('shared')
    expect(coordinator.profile.toolPolicy.allow).toEqual(coordinator.profile.tools)
    expect(coordinator.presets.devboard.sandbox).toEqual({
      level: 'L1',
      required: true,
      on_unavailable: 'deny',
      network_allow: [],
      loopback_serve: true,
    })
    expect(coordinator.profile.tools).toEqual(
      expect.arrayContaining([
        ...tools.map((tool) => tool.name),
        'tool_search',
        'tool_describe',
        'subagent_spawn',
        'subagent_collect',
        'shell',
        'job_output',
        'job_list',
        'job_kill',
      ]),
    )
    expect(application.delegableAgents).toEqual(
      ['requirements', 'architect', 'developer', 'reviewer', 'tester'].map((role) => `${pkg.name}#${role}`),
    )
    for (const ref of application.agents) {
      expect(contracts[ref]?.document.launch?.preset).toBe('devboard')
      const role = bundles[ref.split('#')[1]]
      expect(role.presets.devboard.model.system_prompt.personaPrefix).toContain('全过程')
    }
    for (const ref of application.delegableAgents) {
      expect(application.agents).toContain(ref)
      const role = bundles[ref.split('#')[1]]
      expect(role.profile.tools).toEqual(role.profile.toolPolicy.allow)
      expect(role.profile.skills).toEqual([])
      expect(role.profile.toolPolicy.readOnly).toBe(ref.endsWith('#reviewer') ? true : undefined)
      expect(role.profile.tools.every((name: string) => coordinator.profile.tools.includes(name))).toBe(true)
      expect(role.profile.tools).toEqual(
        ref.endsWith('#reviewer')
          ? ['read', 'ls', 'find', 'grep']
          : ['read', 'ls', 'find', 'grep', 'write', 'edit'],
      )
    }
  })
})
