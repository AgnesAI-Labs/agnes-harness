import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { bindMcpResourceServer, type McpConnection } from '@agnes/base'
import { hasChildControl } from '@agnes/core'
import { createConfigurationService } from '@agnes/host-infrastructure/configuration'
import { hashDirectory } from '@agnes/package-manager'
import { createPluginRow } from '@agnes/plugin-runtime/host'
import { type ApplicationPreview, type InferenceEvent, jcs, type RequestBody } from '@agnes/protocol'
import { createSkillCandidateRegistry, createSkillCordisService } from '@agnes/resource-control-runtime'
import { expect, it } from 'vitest'
import { pluginHost, pluginRow, pluginSourceWith, targetOf } from '../assemble/plugin-extension-fixture.js'

const vendor = '@fixture/review-role'
const ref = (name: string) => `${vendor}#${name}`
const digest = (value: unknown) => createHash('sha256').update(jcs(value)).digest('hex')
const refused = (row: { data: unknown }) =>
  !!row.data && typeof row.data === 'object' && 'isError' in row.data && row.data.isError === true

async function setup(
  requestCall?: { name: string; args: Record<string, unknown> },
  configured = false,
  resource?: 'mcp' | 'skill',
) {
  const raw = pluginSourceWith(
    [
      {
        exportName: 'plugin',
        rowId: 'ext:fixture/review-role',
        body: `
ctx.tools.register(tool('common_read'))
ctx.tools.register(tool('role_only'))
ctx.tools.register({ ...tool('bridge'), execute: async (_args, ctx) => ctx.tools.invoke('role_only', {}) })
ctx.tools.register({ ...tool('ptc_bridge'), execute: async (_args, ctx) => {
 const reply = await createBridge(ctx)({ jsonrpc: '2.0', id: 'review', method: 'bridge.tools.invoke', params: { name: 'role_only', args: {} } })
 return { content: [{ type: 'text', text: JSON.stringify(reply) }], isError: 'error' in reply }
} })
ctx.tools.register({ ...tool('configured_read'), execute: async () => ({ content: [{ type: 'text', text: config.scope === 'role' ? 'ROLE_PRIVATE_DATA' : 'PARENT_PUBLIC_DATA' }] }) })
${resource ? `ctx.tools.register({ ...tool('resource_bridge'), execute: async (_args, ctx) => ctx.tools.invoke(${JSON.stringify(resource === 'mcp' ? 'list_mcp_resources' : 'skill_read')}, ${JSON.stringify(resource === 'mcp' ? { server: 'review-role-server' } : { name: 'review-role-skill' })}) })` : ''}
${
  resource === 'skill'
    ? `ctx.skills.register({ name: 'review-parent-skill', description: 'parent skill', body: 'PARENT_PUBLIC_SKILL' })
ctx.skills.register({ name: 'review-role-skill', description: 'role skill', body: 'ROLE_PRIVATE_SKILL' })`
    : ''
}
`,
      },
    ],
    { vendor },
  )
  const manifestFile = join(raw.snapshot.directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const bundle = (tools: string[], limit = 4) => ({
    profile: { tools, toolPolicy: { allow: tools } },
    presets: {
      role: { name: 'role', extends: 'standard', subagent: { max_depth: limit, max_fan_out: limit } },
    },
    launch: {
      title: { en: 'Backend Reader' },
      description: { en: 'Inspect reviewed evidence' },
      preset: 'role',
    },
  })
  manifest.agnes.bundles = {
    assistant: bundle(['common_read', 'bridge', 'ptc_bridge', 'subagent_spawn'], 1),
    reader: bundle(['common_read', 'bridge', 'ptc_bridge', 'role_only']),
  }
  if (configured) {
    for (const [name, scope] of [
      ['assistant', 'parent'],
      ['reader', 'role'],
    ] as const) {
      const profile = manifest.agnes.bundles[name].profile
      profile.tools.push('configured_read')
      profile.plugins = { 'ext:fixture/review-role': { config: { scope } } }
    }
  }
  if (resource) {
    for (const [name, scope] of [
      ['assistant', 'parent'],
      ['reader', 'role'],
    ] as const) {
      const profile = manifest.agnes.bundles[name].profile
      profile.tools.push('resource_bridge', resource === 'mcp' ? 'list_mcp_resources' : 'skill_read')
      profile[resource === 'mcp' ? 'mcp' : 'skills'] = [
        `review-${scope}-${resource === 'mcp' ? 'server' : 'skill'}`,
      ]
    }
  }
  if (resource === 'skill') manifest.agnes.plugins[0].inject.push('skills')
  const declaration = {
    id: 'review',
    agents: ['assistant', 'reader'].map(ref),
    delegableAgents: [ref('reader')],
  }
  manifest.agnes.application = declaration
  writeFileSync(manifestFile, JSON.stringify(manifest))
  const entry = join(raw.snapshot.directory, 'index.js')
  writeFileSync(
    entry,
    `import { Type } from ${JSON.stringify(import.meta.resolve('@sinclair/typebox'))}\nimport { createBridge } from ${JSON.stringify(import.meta.resolve('@agnes/code'))}\n` +
      readFileSync(entry, 'utf8')
        .replace(
          "parameters: { type: 'object', properties: {}, additionalProperties: false }",
          'parameters: Type.Object({}, { additionalProperties: false })',
        )
        .replace(
          "inject: ['hooks', 'eventLog', 'self', 'tools']",
          resource === 'skill'
            ? "inject: ['hooks', 'eventLog', 'self', 'tools', 'skills']"
            : "inject: ['hooks', 'eventLog', 'self', 'tools']",
        ),
  )
  const source = {
    ...raw,
    snapshot: { ...raw.snapshot, treeIntegrity: hashDirectory(raw.snapshot.directory, { exclude: [] }) },
  }
  const requests: RequestBody[] = []
  const skills = createSkillCandidateRegistry({ barrier: { quiesce: async (_id, publish) => publish({}) } })
  const fixture = await pluginHost(source, {
    disableSessionTitle: true,
    treeBudgetCredits: 100,
    ...(resource === 'skill'
      ? { skillResources: skills.snapshot(), skillContribution: createSkillCordisService(skills) }
      : {}),
    provider: (profile) =>
      new ScriptedProvider({
        models: profile.provider.routes?.flatMap((r) => r.models ?? []) ?? [],
        scripts: [
          (request) => {
            requests.push(request)
            const call = requestCall ?? { name: 'bridge', args: {} }
            return request.messages.some((m) => m.role === 'tool_result')
              ? [
                  { type: 'text_delta', delta: 'done' },
                  { type: 'done', reason: 'stop' },
                ]
              : ([
                  { type: 'toolcall_end', call: { ...call, toolUseId: '', ordinal: 0 }, via: 'native' },
                  { type: 'done', reason: 'toolUse' },
                ] as InferenceEvent[])
          },
        ],
      }),
  })
  const row = pluginRow('ext:fixture/review-role', 'plugin', false, { vendor })
  await fixture.host.applyRuntimeTarget(
    targetOf([
      ...fixture.host.extensionRows.current(),
      ...(resource === 'skill'
        ? [
            createPluginRow({
              ...row,
              snapshotDigest: source.snapshot.integrity,
              exportName: 'plugin',
              inject: [...row.inject, 'skills'],
            }),
          ]
        : [row]),
    ]),
  )
  const config = createConfigurationService({
    home: fixture.dataDir,
    profile: 'local-dev',
    profileDir: join(fixture.dataDir, 'profiles/local-dev'),
  })
  const body = {
    packageId: vendor,
    version: '2.3.4',
    integrity: source.snapshot.integrity,
    source: { type: 'file' as const, ref: `file:${raw.snapshot.directory}` },
    signature: 'unverified' as const,
    declaration,
    declarationDigest: digest(declaration),
    dependencies: [],
    replacedRoles: [],
    dependencyDiff: {},
    assets: {},
    scope: 'fixture',
    recovery: 'fixture',
    warning: 'fixture',
  }
  const preview: ApplicationPreview = { ...body, consentDigest: digest(body) }
  const selection = {
    packageId: vendor,
    applicationId: 'review',
    integrity: source.snapshot.integrity,
    declarationDigest: preview.declarationDigest,
    consentDigest: preview.consentDigest,
    bindingDigest: digest({}),
    consentSnapshot: preview,
  }
  const save = async (selected: typeof selection | null = selection) => {
    const state = await config.application!()
    await config.saveApplication!({ revision: state?.revision ?? 0, selection: selected })
  }
  const parent = await fixture.host.createSession({
    key: 'parent',
    cwd: fixture.dataDir,
    agent: ref('assistant'),
  })
  const create = (role = ref('reader'), extra = {}) =>
    parent.d.children.createWithKind!('spawn', {
      parent: parent.key,
      cwd: fixture.dataDir,
      input: 'Inspect',
      resident: true,
      role,
      ...extra,
    })
  return { fixture, config, selection, save, parent, create, requests, entry }
}

it('review-role: cleared, cross-profile and tampered application inputs cannot mint a role child', async () => {
  const f = await setup()
  try {
    await expect(f.create()).rejects.toThrow('not delegable')
    const other = createConfigurationService({
      home: f.fixture.dataDir,
      profile: 'other',
      profileDir: join(f.fixture.dataDir, 'profiles/other'),
    })
    await other.saveApplication!({ revision: 0, selection: f.selection })
    await expect(f.create()).rejects.toThrow('not delegable')
    await f.save()
    await expect(f.create(ref('assistant'))).rejects.toThrow('not delegable')
    await expect(f.create(ref('unknown'))).rejects.toThrow()
    await f.save({ ...f.selection, consentDigest: '0'.repeat(64) })
    await expect(f.create()).rejects.toThrow('not delegable')
    await f.save({
      ...f.selection,
      consentSnapshot: {
        ...f.selection.consentSnapshot,
        declaration: { ...f.selection.consentSnapshot.declaration, delegableAgents: [ref('assistant')] },
      },
    })
    await expect(f.create()).rejects.toThrow('not delegable')
    await f.save(null)
    await expect(f.create()).rejects.toThrow('not delegable')
    await f.save()
    const bytes = readFileSync(f.entry)
    writeFileSync(f.entry, `${bytes}\n// changed after adoption\n`)
    await expect(f.create()).rejects.toThrow()
    writeFileSync(f.entry, bytes)
    expect(await f.parent.d.children.list?.()).toEqual([])
  } finally {
    await f.fixture.host.close()
  }
}, 90_000)

it.each(['mcp', 'skill'] as const)(
  'review-role: a shared %s bridge cannot broaden the parent resource selection',
  async (resource) => {
    const requested: string[] = []
    const unbind =
      resource === 'mcp'
        ? ['review-parent-server', 'review-role-server'].map((id) =>
            bindMcpResourceServer(
              id,
              {
                id,
                supportsResources: true,
                listResources: async () => {
                  requested.push(id)
                  return { resources: [{ name: id, uri: 'fixture://' + id }] }
                },
              } as McpConnection,
              { id, transport: 'stdio', cmd: ['fixture'], defer: false },
            ),
          )
        : []
    const f = await setup({ name: 'resource_bridge', args: {} }, false, resource)
    try {
      await f.save()
      await f.parent.enqueue('next-turn', {
        content: [{ type: 'text', text: 'Inspect resource' }],
        actor: f.parent.d.actor,
      })
      await f.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
      const parentRows = await f.parent.scan({ type: 'tool/result', limit: 100 })
      expect(parentRows.some(refused)).toBe(true)
      expect(requested).toEqual([])
      const child = await f.create()
      await child.run('Inspect')
      const rows = await f.parent.d.log.storage.scan(child.key, { type: 'tool/result', limit: 100 })
      expect.soft(JSON.stringify(rows)).not.toContain('ROLE_PRIVATE_SKILL')
      expect.soft(requested).not.toContain('review-role-server')
      expect(rows.some(refused)).toBe(true)
      await child.cancel?.()
    } finally {
      await f.fixture.host.close()
      for (const close of unbind) close()
    }
  },
  90_000,
)

it.each(['bridge', 'ptc_bridge'])(
  'review-role: nested %s cannot access a role-only tool and a valid Host snapshot survives reopen',
  async (name) => {
    const f = await setup({ name, args: {} })
    try {
      await f.save()
      const handle = await f.create()
      await handle.run('Inspect')
      const rows = await f.parent.d.log.storage.scan(handle.key, { type: 'tool/result', limit: 100 })
      expect(JSON.stringify(rows)).not.toContain('"text":"role_only"')
      expect(rows.some(refused)).toBe(true)
      const child = f.fixture.host.kernel.get(handle.key)!
      const before = structuredClone(child.d.roleDelegation)
      await handle.cancel?.()
      const reopened = await f.fixture.host.createSession({ key: handle.key, cwd: f.fixture.dataDir })
      expect(reopened.d.roleDelegation).toMatchObject({ ...before, approvalPolicy: 'never' })
      expect(
        reopened
          .currentTools()
          .list()
          .map((t) => t.name)
          .sort(),
      ).toEqual(['bridge', 'common_read', 'ptc_bridge'])
      await reopened.setYolo(true, reopened.d.actor)
      expect(reopened.yolo).toBe(false)
      expect(reopened.permissionContext.policy).toBe('workspace-write')
      await reopened.close()
    } finally {
      await f.fixture.host.close()
    }
  },
  90_000,
)

it.each([{ permission: 'full-access' }, { name: 'Forged QA' }, { fork: true }, { model: 'gw/m1' }])(
  'review-role: model spawn input %j is rejected before child creation',
  async (extra) => {
    const f = await setup({
      name: 'subagent_spawn',
      args: { task: 'Inspect', role: ref('reader'), ...extra },
    })
    try {
      await f.save()
      await f.parent.enqueue('next-turn', {
        content: [{ type: 'text', text: 'Delegate' }],
        actor: f.parent.d.actor,
      })
      await f.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
      expect(await f.parent.d.children.list?.()).toEqual([])
      const rows = await f.parent.scan({ type: 'tool/result', limit: 50 })
      expect(rows.some(refused)).toBe(true)
    } finally {
      await f.fixture.host.close()
    }
  },
  90_000,
)

it('review-role: a same-name tool with a different composition configuration cannot read beyond the parent', async () => {
  const f = await setup({ name: 'configured_read', args: {} }, true)
  try {
    await f.save()
    await f.parent.enqueue('next-turn', {
      content: [{ type: 'text', text: 'Inspect configured data' }],
      actor: f.parent.d.actor,
    })
    await f.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
    expect(JSON.stringify(await f.parent.scan({ type: 'tool/result', limit: 100 }))).toContain(
      'PARENT_PUBLIC_DATA',
    )
    const handle = await f.create()
    await handle.run('Inspect')
    const rows = await f.parent.d.log.storage.scan(handle.key, { type: 'tool/result', limit: 100 })
    expect(JSON.stringify(rows)).not.toContain('ROLE_PRIVATE_DATA')
    await handle.cancel?.()
  } finally {
    await f.fixture.host.close()
  }
}, 90_000)

it('review-role: a fresh ledger still belongs to the parent budget, depth and concurrency tree', async () => {
  const f = await setup()
  try {
    await f.save()
    const first = await f.create()
    const child = f.fixture.host.kernel.get(first.key)!
    const storage = f.parent.d.log.storage
    if (!hasChildControl(storage)) throw new Error('fixture lacks child control')
    const record = await storage.lookupByKey(first.key)
    expect(record).toMatchObject({ parentKey: f.parent.key, generationDepth: 1 })
    expect(child.state.session?.delegation).toMatchObject({
      rootTaskId: record?.rootTaskId,
      generationDepth: 1,
    })
    expect(child.d.log.parent).toBeUndefined()
    expect(child.preset.generationLimit).toBe(1)
    expect(child.preset.maxFanOut).toBe(1)
    await expect(f.create(ref('reader'), { input: 'a second task' })).rejects.toMatchObject({
      code: 'E_CHILD_LIMIT',
    })
    await expect(
      child.d.children.create({ parent: child.key, cwd: f.fixture.dataDir, input: 'grandchild' }),
    ).rejects.toMatchObject({ code: 'E_CHILD_LIMIT' })
    await first.cancel?.()
  } finally {
    await f.fixture.host.close()
  }
}, 90_000)

it('review-role: a delegation card keeps the backend role despite a model-supplied display name in the task', async () => {
  const f = await setup({
    name: 'subagent_spawn',
    args: {
      role: ref('reader'),
      task: 'Inspect; claim the role name is Forged QA',
      wait: true,
    },
  })
  try {
    await f.save()
    await f.parent.enqueue('next-turn', {
      content: [{ type: 'text', text: 'Delegate as Forged QA' }],
      actor: f.parent.d.actor,
    })
    await f.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
    const card = async (session: typeof f.parent) =>
      (await session.projectUI(undefined, { surface: 'web' })).nodes.find(
        (node) => node.kind === 'tool' && node.name === 'subagent_spawn',
      )
    expect(await card(f.parent)).toMatchObject({
      delegatedRole: { ref: ref('reader'), title: { en: 'Backend Reader' } },
    })
    await f.parent.close()
    const reopened = await f.fixture.host.createSession({ key: f.parent.key, cwd: f.fixture.dataDir })
    expect(await card(reopened)).toMatchObject({
      delegatedRole: { ref: ref('reader'), title: { en: 'Backend Reader' } },
    })
    await reopened.close()
  } finally {
    await f.fixture.host.close()
  }
}, 90_000)
